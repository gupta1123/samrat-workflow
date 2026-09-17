import type { CaseDoc, Mismatch } from "../../types/pipeline";
import { FIELD_DEFINITIONS } from "../document-schema";
import { buildDocumentReadabilityMismatches } from "../document-readability";
import { EXTRACTION_VERIFICATION_FIELD } from "../../lib/extraction-verification";
import { readComparisonOptions } from "../comparison";
import {
  buildAuthoritativeReviewResponseSchema,
  parseValidatedPacketReconciliation,
  validateMismatchDecisionBatch,
  verifyProcessedDocuments,
  type ExtractionReviewSummary,
  type ReviewSourcePage,
} from "./pipeline";
import {
  callExtractionReviewModel,
  getExtractionReviewModel,
  getExtractionReviewProvider,
  getExtractionReviewReasoningEffort,
  OpenRouterOutputLimitError,
  type OpenRouterMessage,
} from "./openrouter";
import { ReviewContractError } from "./review-contract-error";
import {
  buildSourceAuditSchema,
  ownDocumentPages,
  parseCompactSourceAudit,
  parseGroundedReviewIssues,
  sourceAuditContext,
  STAGED_REVIEW_CONTRACT_VERSION,
} from "./staged-review-contract";
import {
  cachedReviewStage,
  reviewCheckpointKey,
  reviewInputDigest,
  type ReviewCheckpointStore,
} from "./review-checkpoints";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed review object.");
  return value as Record<string, unknown>;
}
function configuredPositive(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value >= 1
    ? Math.min(maximum, Math.floor(value))
    : fallback;
}
function sourceFingerprint(pages: ReviewSourcePage[]) {
  return pages.map(({ sourceFileName, pageNumber, image }) => ({
    sourceFileName,
    pageNumber,
    imageDigest: reviewInputDigest(image),
  }));
}
function modelSettings() {
  return {
    model: getExtractionReviewModel(),
    reasoning: getExtractionReviewReasoningEffort(),
  };
}

export async function mapReviewTasks<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
) {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("Review concurrency must be a positive integer.");
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed: unknown;
  let hasFailed = false;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!hasFailed && next < items.length) {
        const index = next++;
        try {
          results[index] = await task(items[index], index);
        } catch (error) {
          if (!hasFailed) failed = error;
          hasFailed = true;
        }
      }
    }),
  );
  // Finish in-flight reviews/checkpoint writes before releasing the job lease.
  if (hasFailed) throw failed;
  return results;
}

export function buildMismatchReviewBatches(
  candidates: Mismatch[],
  batchSize: number,
) {
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new Error("Decision batch size must be a positive integer.");
  return Array.from(
    { length: Math.ceil(candidates.length / batchSize) },
    (_, index) => ({
      offset: index * batchSize,
      candidates: candidates.slice(index * batchSize, (index + 1) * batchSize),
    }),
  );
}

async function completeReviewRequest<T>(options: {
  operation: string;
  schema: Record<string, unknown>;
  messages: OpenRouterMessage[];
  maxTokens: number;
  validate: (raw: string) => T;
}) {
  let defect = "";
  let rejected = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages: OpenRouterMessage[] =
      attempt === 1
        ? options.messages
        : [
            ...options.messages,
            ...(rejected
              ? [{ role: "assistant" as const, content: rejected }]
              : []),
            {
              role: "user",
              content:
                "Return a complete compact response for ONLY this task. " +
                `The previous response was not accepted: ${defect}. ` +
                "Keep source evidence exact and brief. Do not repeat unchanged tables, invent values, omit required checks, or review other tasks.",
            },
          ];
    let raw: string;
    try {
      raw = await callExtractionReviewModel(messages, {
        operation: options.operation,
        maxTokens: options.maxTokens,
        responseSchema: {
          name: options.operation.replaceAll("-", "_"),
          strict: true,
          schema: options.schema,
        },
      });
    } catch (error) {
      if (!(error instanceof OpenRouterOutputLimitError)) throw error;
      defect = error instanceof Error ? error.message : String(error);
      console.warn("[staged-review] task response rejected", {
        operation: options.operation,
        attempt,
        defect,
      });
      rejected = "";
      continue;
    }
    try {
      rejected = raw;
      return { raw, result: options.validate(raw), attempts: attempt };
    } catch (error) {
      defect = error instanceof Error ? error.message : String(error);
      console.warn("[staged-review] task response rejected", {
        operation: options.operation,
        attempt,
        defect,
      });
    }
  }
  throw new ReviewContractError(
    `Review task ${options.operation} could not be verified after two attempts. ${defect}`,
  );
}

const SOURCE_REVIEW_INSTRUCTION =
  "You are the Pro source-reviewer for ONE document. Return ONLY the required compact JSON. " +
  "Read its original pages; first-pass fields and visibleText are untrusted proposals. " +
  "Every pageNumber is a supplied sourcePagePointers pointer such as p1, NOT an integer. The app binds it to the exact original page. Do not use local numbers or an extracted table's sourcePage. " +
  'The response structure is {"sourceVerdict":"verified|needs_review","fieldChecks":{"requestedField":"supported|unsupported"},"lineItemChecks":{"requestedProperty":"supported|unsupported"},"references":{"canonicalReferenceField":{"value":"literal printed value or null","sourceLabel":"literal label","valueKind":"reference|document_type|date|party|other|absent|unreadable","pageNumber":"supplied pointer","quote":"literal own-page label and value"}},"newReferences":[],"fieldChanges":[{"field":"canonical non-reference field","value":"source-based value","evidenceKind":"printed|visual_observation","pageNumber":"supplied pointer","quote":"literal own-page words"}],"removalEvidence":null,"structureChange":null,"pageQuality":[{"pageNumber":"supplied pointer","issues":[],"approvalSafe":true,"confidence":"high|medium|low","reason":"visual assessment"}],"reviewIssues":[],"reason":"source-based explanation"}. This is a shape guide, not findings: inspect the pixels to fill every nested evidence and quality property; never return empty evidence objects. references can be {} when no references exist. Empty arrays mean no entries, not one empty object. ' +
  "Check EVERY populated field and every populated line-item property, and inspect for omitted, explicitly labelled values. " +
  "fieldChecks and lineItemChecks are OBJECTS keyed by the supplied fieldChecksInOrder and lineItemChecksInOrder names. Return every listed key exactly once with supported or unsupported; do not use positional arrays or review the corrected field set. " +
  "Supported means the field/property belongs to this source, including a misread value that you correct. Unsupported means the source never supplies that field/property. The app removes unsupported values directly from your votes; provide removalEvidence for those votes, not a second removal list. " +
  "A correct normalized representation is still supported: keep it when the printed content has the same meaning. Do not return changes merely to add commas/decimal zeroes, rearrange date formatting, or rewrap text; source review corrects actual wrong/missing values, not harmless presentation. Never remove a supported field just because its formatting differs. " +
  "references is the authority for ORIGINAL reference proposals: it is an OBJECT keyed by every referencesToReview field, NOT an array. Each key has one value-and-proof entry; do not put field inside that entry. " +
  "newReferences is an array only for clearly printed newly discovered references not in referencesToReview. Each entry supplies field, value, sourceLabel, valueKind, pageNumber and quote. Never repeat an original or new field; the app joins these distinct entries into the same final reference ledger. Use [] when none were missed. " +
  "Each retained value requires valueKind reference and a brief own-page quote containing its EXACT printed label and value together. " +
  "Judge labels by meaning and layout, not by matching their words to field names. Categories, titles, dates, parties and different references are not interchangeable IDs. " +
  "Remove a mis-mapped reference with value null and its true source meaning. A physically blank invoice number stays absent; never substitute a PO, e-way bill, challan or LR number. " +
  "The mandatory invoice-number policy is enforced by the application; do not duplicate that missing-field warning in reviewIssues. " +
  "Source context from other documents or filenames must NEVER fill a missing field. " +
  "fieldChanges is the ONLY authority for NON-reference additions or corrections. Each record pairs field, EXACT printed value, pageNumber and the minimum own-page quote containing that value. Do not repeat the finding anywhere else. " +
  "Each fieldChange includes evidenceKind matching that field's fieldMeanings metadata. printed evidence requires value copied VERBATIM from quote, including internal spacing and punctuation. visual_observation is permitted ONLY for fields explicitly declared visual_observation: describe the observed mark/presence in quote on its own page, not a fabricated printed Yes/No. Do not keep a known wrong visual flag merely because its correct answer is not printed text. " +
  "Do not add blank, absent, unreadable, calculated or inferred values. Retain valid existing formatting rather than normalizing dates, amounts, or units. Use an empty fieldChanges array when no printed-value change is needed. " +
  "structureChange is null unless documentType or table rows truly need correction; supply its own evidence and only actual structural changes. Do not repeat an unchanged table to remove unsupported properties: the app does that from your lineItemChecks votes. " +
  "Return sourceVerdict verified when the source is decidable, even if changes are required; needs_review when it is not. " +
  "Assess EVERY supplied page. Faint, materially rotated, blurred, cropped or unreadable pages need the corresponding quality warning and approvalSafe false. " +
  "Use reviewIssues only for unresolved source findings with printed evidence; no invented business conflicts. " +
  "Return all required arrays, using empty arrays where appropriate. Keep reasons brief and do not include document IDs or filenames: the task binds its own source pointers.";

async function reviewOneSource(options: {
  document: CaseDoc;
  pages: ReviewSourcePage[];
  store?: ReviewCheckpointStore;
  recheckReason?: string;
}) {
  const context = sourceAuditContext(
    options.document,
    options.pages,
    options.recheckReason,
  );
  const { id: ignoredId, ...documentInput } = options.document;
  void ignoredId;
  const key = reviewCheckpointKey("source", {
    document: documentInput,
    pages: sourceFingerprint(options.pages),
    settings: modelSettings(),
    recheckReason: options.recheckReason ?? null,
  });
  const validate = (raw: string) =>
    parseCompactSourceAudit(raw, options.document, options.pages);
  const cached = await cachedReviewStage({
    key,
    store: options.store,
    validate,
    run: () =>
      completeReviewRequest({
        operation: "source-document-review",
        validate,
        maxTokens: configuredPositive(
          "PACKET_SOURCE_REVIEW_MAX_OUTPUT_TOKENS",
          8192,
          32768,
        ),
        schema: buildSourceAuditSchema(options.document, options.pages),
        messages: [
          { role: "system", content: SOURCE_REVIEW_INSTRUCTION },
          {
            role: "user",
            content: [
              { type: "text", text: JSON.stringify(context) },
              ...options.pages.flatMap((page, index) => [
                {
                  type: "text" as const,
                  text: `Own page pointer p${index + 1} (original page ${page.pageNumber})`,
                },
                { type: "image_url" as const, image_url: { url: page.image } },
              ]),
            ],
          },
        ],
      }),
  });
  return { ...cached, key };
}

// Compact request-local pointers are lossless aliases. Only pointer properties
// are translated. Printed values, evidence quotes and free text are untouched.
export function packetPointerAliases(documents: CaseDoc[]) {
  const documentToAlias = new Map(
    documents.map((document, index) => [document.id, `d${index + 1}`]),
  );
  const fileNames = [
    ...new Set(
      documents
        .map((document) => document.sourceFileName)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const fileToAlias = new Map(
    fileNames.map((name, index) => [name, `f${index + 1}`]),
  );
  const aliasToDocument = new Map(
    [...documentToAlias].map(([key, value]) => [value, key]),
  );
  const aliasToFile = new Map(
    [...fileToAlias].map(([key, value]) => [value, key]),
  );
  const docPointers = new Set(["docId", "documentId", "sourceDocId"]);
  const docLists = new Set([
    "documentIds",
    "primaryDocumentIds",
    "contextDocumentIds",
    "evidenceDocIds",
    "outlierDocumentIds",
  ]);
  function translate(value: unknown, decode: boolean, property = ""): unknown {
    const docs = decode ? aliasToDocument : documentToAlias;
    const files = decode ? aliasToFile : fileToAlias;
    if (
      typeof value === "string" &&
      (docPointers.has(property) || property === "sourceFileName")
    ) {
      const replacement = (property === "sourceFileName" ? files : docs).get(
        value,
      );
      if (!replacement)
        throw new Error(`Unknown review source pointer: ${value}.`);
      return replacement;
    }
    if (Array.isArray(value)) {
      if (docLists.has(property))
        return value.map((entry) => {
          const replacement =
            typeof entry === "string" ? docs.get(entry) : undefined;
          if (!replacement)
            throw new Error(
              "Packet review returned an unknown document pointer.",
            );
          return replacement;
        });
      return value.map((entry) => translate(entry, decode));
    }
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          translate(entry, decode, key),
        ]),
      );
    return value;
  }
  return {
    documentToAlias,
    fileToAlias,
    encode: (value: unknown) => translate(value, false),
    decode: (value: unknown) => translate(value, true),
  };
}

const PACKET_INSTRUCTION =
  "You are the SAME Pro review role performing whole-packet reconciliation AFTER mandatory own-source audits. Return compact JSON for ONLY this task. " +
  "All supplied document fields are source-audited. Their sourceAudits/pageQuality describe verified corrections and reading limits. " +
  "Use the entire packet to decide document roles, actual shipment relationships, explicit terms, missing evidence and root business discrepancies. " +
  "Preliminary groups and candidate mismatches are untrusted proposals, not established facts. Do not create a difference from OCR noise, formatting, equivalent units or a downstream numerical symptom. " +
  "Use seller_chain only when the seller-to-buyer sequence is proved: buyer-facing invoices are primary and upstream invoices are context, not additional invoices to reconcile. " +
  "Assign every document to exactly one group. Choose counterpartySource from the external supplier's vendorName for a purchase, never buyerName, a carrier or upstream context. " +
  "Copy summary references exactly from retained primary fields; invoiceNumber stays empty when the actual invoice's number is blank. " +
  "Use compact document/file aliases ONLY as pointers. Never derive an identifier from an alias, filename, heading, date or another source. " +
  "Do NOT copy fields, proofs, corrections, source audits or page-quality arrays in this response. " +
  "If original pages reveal a concrete error in the audited fields, return sourceRecheckRequests identifying the document and precise source problem; never silently change its fields. " +
  "Do not request a recheck simply because a page is already flagged unreadable/rotated: retain that safety warning. " +
  "Return a termsChecklist covering every explicit packet-testable clause; unknown obligations are not commercial mismatches. " +
  "packetIssues contains ONLY newly found source-proved discrepancies not already represented by candidateMismatches. Every evidence value must be printed in its own cited page quote. " +
  "The app handles mandatory blank invoice numbers and core missing documents; do not duplicate those checks in packetIssues. " +
  "Candidate decisions are handled in bounded subsequent tasks using this same full context: do not copy mismatchDecisions here. " +
  "Keep reasons and quotes brief; use empty arrays for no findings.";

function packetTaskSchema(documents: CaseDoc[], pages: ReviewSourcePage[]) {
  const properties = object(
    buildAuthoritativeReviewResponseSchema({
      documentCount: documents.length,
      mismatchCount: 0,
      pageCount: pages.length,
      documents,
    }).properties,
  );
  const text = { type: "string" };
  return {
    type: "object",
    properties: {
      packetGroups: properties.packetGroups,
      termsChecklist: properties.termsChecklist,
      sourceRecheckRequests: {
        type: "array",
        items: {
          type: "object",
          properties: { docId: text, reason: text },
          required: ["docId", "reason"],
          additionalProperties: false,
        },
      },
      packetIssues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: text,
            reason: text,
            evidence: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  docId: text,
                  sourceFileName: text,
                  pageNumber: { type: "integer" },
                  value: text,
                  quote: text,
                },
                required: [
                  "docId",
                  "sourceFileName",
                  "pageNumber",
                  "value",
                  "quote",
                ],
                additionalProperties: false,
              },
            },
          },
          required: ["field", "reason", "evidence"],
          additionalProperties: false,
        },
      },
      notes: properties.notes,
    },
    required: [
      "packetGroups",
      "termsChecklist",
      "sourceRecheckRequests",
      "packetIssues",
      "notes",
    ],
    additionalProperties: false,
  };
}

export async function reviewExtractedDocumentsInStages(
  documents: CaseDoc[],
  options: {
    sourcePages: ReviewSourcePage[];
    comparisonOptions?: unknown;
    checkpoints?: ReviewCheckpointStore;
    onReviewStage?: (progress: number, stage: string) => Promise<void>;
  },
) {
  if (process.env.PACKET_EXTRACTION_REVIEW_ENABLED === "false")
    throw new Error("Authoritative packet review cannot be disabled.");
  if (
    !documents.length ||
    new Set(documents.map((document) => document.id)).size !== documents.length
  )
    throw new ReviewContractError(
      "Staged review requires a non-empty unique document set.",
    );
  let completed = 0;
  let reused = 0;
  let sourceAttempts = 0;
  let stageQueue = Promise.resolve();
  const report = (progress: number, stage: string) => {
    stageQueue = stageQueue.then(() =>
      options.onReviewStage?.(progress, stage),
    );
    return stageQueue;
  };
  await report(
    84,
    `Source reviewer checking 0 of ${documents.length} documents`,
  );
  const concurrency = configuredPositive(
    "PACKET_SOURCE_REVIEW_CONCURRENCY",
    3,
    6,
  );
  const sourceReviews = await mapReviewTasks(
    documents,
    concurrency,
    async (document) => {
      const result = await reviewOneSource({
        document,
        pages: ownDocumentPages(document, options.sourcePages),
        store: options.checkpoints,
      });
      if (result.reused) reused++;
      sourceAttempts += result.attempts;
      completed++;
      await report(
        84 + Math.round((9 * completed) / documents.length),
        `Source review complete: ${completed} of ${documents.length} documents${reused ? ` (${reused} resumed)` : ""}`,
      );
      return result.result;
    },
  );
  const correctionHistory = sourceReviews.flatMap(
    (result) => result.summary.corrections,
  );
  const currentDocuments = sourceReviews.map((result) => result.document);
  let candidates: Mismatch[] = [];
  let packetRaw: Record<string, unknown> | undefined;
  let packetContext: Record<string, unknown> = {};
  let aliases = packetPointerAliases(currentDocuments);
  let packetAttempts = 0;
  const parsePacket = (raw: string) => {
    const payload = object(aliases.decode(JSON.parse(raw)));
    const allowed = new Set([
      "packetGroups",
      "termsChecklist",
      "sourceRecheckRequests",
      "packetIssues",
      "notes",
    ]);
    if (
      Object.keys(payload).some((key) => !allowed.has(key)) ||
      !Array.isArray(payload.sourceRecheckRequests) ||
      !Array.isArray(payload.notes)
    )
      throw new Error(
        "Packet task returned fields outside its reconciliation contract.",
      );
    const requests = payload.sourceRecheckRequests.map((value) => {
      const request = object(value);
      if (
        !currentDocuments.some((document) => document.id === request.docId) ||
        typeof request.reason !== "string" ||
        !request.reason.trim()
      )
        throw new Error(
          "Packet task returned an invalid source recheck request.",
        );
      return { docId: request.docId as string, reason: request.reason };
    });
    if (
      new Set(requests.map((request) => request.docId)).size !== requests.length
    )
      throw new Error(
        "Packet task returned duplicate source recheck requests.",
      );
    const audits = sourceReviews.map((result) => result.audit);
    parseValidatedPacketReconciliation({
      raw: JSON.stringify({ ...payload, mismatchDecisions: [] }),
      documents: currentDocuments,
      candidateMismatches: [],
      documentAudits: audits,
      sourcePages: options.sourcePages,
    });
    parseGroundedReviewIssues(
      payload.packetIssues,
      currentDocuments,
      options.sourcePages,
      "packet",
    );
    return { payload, requests };
  };
  for (let pass = 0; pass < 2; pass++) {
    await report(94, "Pro reviewer reconciling the whole verified packet");
    const preliminary = verifyProcessedDocuments(
      currentDocuments,
      readComparisonOptions(options.comparisonOptions),
    );
    candidates = preliminary.mismatches;
    aliases = packetPointerAliases(currentDocuments);
    packetContext = object(
      aliases.encode({
        contractVersion: STAGED_REVIEW_CONTRACT_VERSION,
        fieldMeanings: FIELD_DEFINITIONS.map(({ key, label }) => ({
          field: key,
          meaning: label,
        })),
        documents: currentDocuments.map((document) => ({
          docId: document.id,
          documentType: document.type,
          title: document.title,
          sourceFileName: document.sourceFileName,
          sourcePageNumbers: document.sourcePageNumbers,
          fields: document.fields,
          lineItems: document.lineItems ?? [],
          visibleText: document.md,
        })),
        sourceAudits: sourceReviews.map((result) => ({
          docId: result.document.id,
          status: result.audit.status,
          reason: result.audit.reason,
        })),
        pageQuality: sourceReviews.flatMap((result) => result.pageQuality),
        candidateMismatches: candidates.map((candidate, index) => ({
          mismatchId: `mismatch-${index + 1}`,
          field: candidate.field,
          values: candidate.values,
          analysis: candidate.analysis,
        })),
        preliminaryGroups: preliminary.verificationGroups,
      }),
    );
    const messages: OpenRouterMessage[] = [
      { role: "system", content: PACKET_INSTRUCTION },
      {
        role: "user",
        content: [
          { type: "text", text: JSON.stringify(packetContext) },
          ...options.sourcePages.flatMap((page) => [
            {
              type: "text" as const,
              text: `Original file ${aliases.fileToAlias.get(page.sourceFileName)}, page ${page.pageNumber}`,
            },
            { type: "image_url" as const, image_url: { url: page.image } },
          ]),
        ],
      },
    ];
    const key = reviewCheckpointKey("packet", {
      context: packetContext,
      sources: sourceFingerprint(options.sourcePages),
      settings: modelSettings(),
    });
    const result = await cachedReviewStage({
      key,
      store: options.checkpoints,
      validate: parsePacket,
      cacheWhen: (result) => result.requests.length === 0,
      run: async () => {
        const result = await completeReviewRequest({
          operation: "packet-reconciliation",
          validate: parsePacket,
          schema: packetTaskSchema(currentDocuments, options.sourcePages),
          messages,
          maxTokens: configuredPositive(
            "PACKET_RECONCILIATION_MAX_OUTPUT_TOKENS",
            8192,
            32768,
          ),
        });
        packetAttempts += result.attempts;
        return result;
      },
    });
    if (result.reused) reused++;
    packetRaw = result.result.payload;
    if (!result.result.requests.length) break;
    if (pass === 1)
      throw new ReviewContractError(
        "Packet source contradictions remain after targeted source rechecks; approval is blocked.",
      );
    await mapReviewTasks(
      result.result.requests,
      concurrency,
      async (request) => {
        const index = currentDocuments.findIndex(
          (document) => document.id === request.docId,
        );
        await report(
          94,
          `Re-reading a specific source finding: ${currentDocuments[index].title}`,
        );
        const result = await reviewOneSource({
          document: currentDocuments[index],
          pages: ownDocumentPages(currentDocuments[index], options.sourcePages),
          store: options.checkpoints,
          recheckReason: request.reason,
        });
        correctionHistory.push(...result.result.summary.corrections);
        sourceReviews[index] = result.result;
        currentDocuments[index] = result.result.document;
        if (result.reused) reused++;
        sourceAttempts += result.attempts;
      },
    );
  }
  if (!packetRaw)
    throw new ReviewContractError("Packet reconciliation did not complete.");
  const batchSize = configuredPositive(
    "PACKET_REVIEW_DECISION_BATCH_SIZE",
    12,
    24,
  );
  const batches = buildMismatchReviewBatches(candidates, batchSize);
  let decisionCompleted = 0;
  let decisionAttempts = 0;
  const decisions = await mapReviewTasks(
    batches,
    concurrency,
    async (batch) => {
      const baseProperties = object(
        buildAuthoritativeReviewResponseSchema({
          documentCount: currentDocuments.length,
          mismatchCount: batch.candidates.length,
          pageCount: options.sourcePages.length,
          documents: currentDocuments,
        }).properties,
      );
      const schema = {
        type: "object",
        properties: { mismatchDecisions: baseProperties.mismatchDecisions },
        required: ["mismatchDecisions"],
        additionalProperties: false,
      };
      const localIds = batch.candidates.map(
        (_, index) => `mismatch-${index + 1}`,
      );
      const validate = (raw: string) => {
        const payload = object(aliases.decode(JSON.parse(raw)));
        if (Object.keys(payload).some((key) => key !== "mismatchDecisions"))
          throw new Error("Decision batch returned unrelated work.");
        validateMismatchDecisionBatch(
          payload.mismatchDecisions,
          batch.candidates,
        );
        return (payload.mismatchDecisions as Record<string, unknown>[]).map(
          (decision) => ({
            ...decision,
            mismatchId: `mismatch-${batch.offset + localIds.indexOf(String(decision.mismatchId)) + 1}`,
          }),
        );
      };
      const batchContext = {
        ...packetContext,
        requestedCandidates: aliases.encode(
          batch.candidates.map((candidate, index) => ({
            mismatchId: localIds[index],
            field: candidate.field,
            values: candidate.values,
            analysis: candidate.analysis,
          })),
        ),
        packetReconciliation: aliases.encode(packetRaw),
      };
      const key = reviewCheckpointKey("decisions", {
        context: batchContext,
        sources: sourceFingerprint(options.sourcePages),
        settings: modelSettings(),
      });
      const result = await cachedReviewStage({
        key,
        store: options.checkpoints,
        validate,
        run: async () => {
          const result = await completeReviewRequest({
            operation: "packet-mismatch-decisions",
            validate,
            schema,
            maxTokens: configuredPositive(
              "PACKET_DECISION_REVIEW_MAX_OUTPUT_TOKENS",
              6144,
              32768,
            ),
            messages: [
              {
                role: "system",
                content:
                  "You are the same Pro packet reviewer deciding ONLY requestedCandidates. Return exactly one mismatchDecision per requested candidate, using its LOCAL mismatchId. " +
                  "The all-packet candidate list is context only; do not copy its IDs into this batch's responses. Check the entire source-audited packet and original pages. " +
                  "Confirm only printed, independent business discrepancies; dismiss OCR noise, equivalent units, formatting and derivative numerical symptoms. " +
                  "Use seller-chain primary/context roles. A quantity/vehicle/weight conflict is not a tax mismatch when each source's tax arithmetic is internally correct. " +
                  "Do not attribute unproven business errors to unreadable pages; those already have blocking source warnings. " +
                  "primary true means root discrepancy. outlierDocumentIds may include only documents cited by this candidate, or empty when direction is unproved. " +
                  "Keep reasons brief. Never invent a discrepancy to justify a machine-generated candidate.",
              },
              {
                role: "user",
                content: [
                  { type: "text", text: JSON.stringify(batchContext) },
                  ...options.sourcePages.flatMap((page) => [
                    {
                      type: "text" as const,
                      text: `Original file ${aliases.fileToAlias.get(page.sourceFileName)}, page ${page.pageNumber}`,
                    },
                    {
                      type: "image_url" as const,
                      image_url: { url: page.image },
                    },
                  ]),
                ],
              },
            ],
          });
          decisionAttempts += result.attempts;
          return result;
        },
      });
      if (result.reused) reused++;
      decisionCompleted++;
      await report(
        94 + Math.round((2 * decisionCompleted) / Math.max(1, batches.length)),
        `Packet decision review complete: ${decisionCompleted} of ${batches.length} batches`,
      );
      return result.result;
    },
  );
  const result = parseValidatedPacketReconciliation({
    raw: JSON.stringify({ ...packetRaw, mismatchDecisions: decisions.flat() }),
    documents: currentDocuments,
    candidateMismatches: candidates,
    documentAudits: sourceReviews.map((result) => result.audit),
    sourcePages: options.sourcePages,
  });
  const pageQuality = sourceReviews.flatMap((result) => result.pageQuality);
  const reviewIssues = [
    ...sourceReviews.flatMap((result) => result.reviewIssues),
    ...parseGroundedReviewIssues(
      packetRaw.packetIssues,
      currentDocuments,
      options.sourcePages,
      "packet",
    ),
    ...buildDocumentReadabilityMismatches(pageQuality),
    ...sourceReviews
      .filter(
        (result) =>
          result.audit.status === "needs_review" &&
          result.pageQuality.every((page) => page.approvalSafe) &&
          !result.reviewIssues.length,
      )
      .map((result) => ({
        id: `evidence-review-source-unresolved-${result.document.id}`,
        field: EXTRACTION_VERIFICATION_FIELD,
        values: [
          {
            docId: result.document.id,
            value: "Source verification needs review",
          },
        ],
        analysis: result.audit.reason,
        fixPlan:
          "Replace the unclear document and analyze again before approval.",
      })),
  ];
  const corrections = [
    ...new Map(
      correctionHistory.map((correction) => [correction.docId, correction]),
    ).values(),
  ];
  const unresolved =
    sourceReviews.some((result) => result.audit.status === "needs_review") ||
    pageQuality.some((page) => !page.approvalSafe) ||
    reviewIssues.length > 0 ||
    result.authoritativeReview.mismatches.length > 0 ||
    result.authoritativeReview.termsChecklist.some(
      (item) => item.status === "not_fulfilled",
    );
  const review: ExtractionReviewSummary = {
    enabled: true,
    required: true,
    authoritative: true,
    semanticPostProcessing: false,
    model: getExtractionReviewModel(),
    provider: getExtractionReviewProvider(),
    reasoningEffort: getExtractionReviewReasoningEffort(),
    reviewedAt: new Date().toISOString(),
    verdict: unresolved
      ? "needs_review"
      : corrections.length
        ? "corrected"
        : "pass",
    correctionCount: corrections.length,
    reviewIssueCount: reviewIssues.length,
    corrections,
    attemptCount: sourceAttempts + packetAttempts + decisionAttempts,
    candidateMismatchCount: candidates.length,
    confirmedMismatchCount: result.confirmedMismatchCount,
    dismissedMismatchCount: result.dismissedMismatchCount,
    termsChecklistCount: result.authoritativeReview.termsChecklist.length,
    packetGroupCount: result.authoritativeReview.verificationGroups.length,
    documentAudits: sourceReviews.map((result) => result.audit),
    warnings: sourceReviews.flatMap((result) => result.summary.warnings),
    executionMode: "staged",
    sourceReviewCount: sourceReviews.length,
    resumedCheckpointCount: reused,
    decisionBatchCount: batches.length,
  };
  await report(
    96,
    "All source and packet review tasks verified; preparing results",
  );
  return {
    documents: currentDocuments,
    review,
    reviewIssues,
    pageQuality,
    authoritativeReview: result.authoritativeReview,
  };
}
