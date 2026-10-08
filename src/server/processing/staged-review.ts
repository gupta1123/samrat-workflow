import type { CaseDoc, Mismatch } from "../../types/pipeline";
import { RequestSizeError, requestByteLimit } from "./request-budget";
import {
  packetEvidenceBatches,
  pageEvidenceMessages,
  validatePageEvidence,
  reviewRequestBody,
  PAGE_EVIDENCE_SCHEMA,
  type PageEvidence,
} from "./packet-evidence";
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
  getExtractionReviewFallbackModel,
  getExtractionReviewModel,
  getExtractionReviewProvider,
  getExtractionReviewReasoningEffort,
  isRetryableOpenRouterError,
  OpenRouterOutputLimitError,
  type OpenRouterMessage,
} from "./openrouter";
import {
  ReviewContractError,
  SourceReviewValidationError,
  type SourceReviewValidationSection,
} from "./review-contract-error";
import {
  buildSourceAuditRepairSchema,
  buildSourceAuditSchema,
  buildSourceFieldChangesRepairSchema,
  buildSourceIssuesRepairSchema,
  isolateUnverifiedSourceReferences,
  buildSourceReferenceRepairSchema,
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
import {
  buildRootCauseCandidates,
  materializeRootCauseMismatches,
  ROOT_CAUSE_REVIEW_SCHEMA,
  validateRootCauseReview,
} from "./mismatch-root-causes";

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
    fallbackModel: getExtractionReviewFallbackModel(),
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
  outputLimitFallbackModel?: string;
  stopAfterValidationSections?: SourceReviewValidationSection[];
  validate: (raw: string) => T;
}) {
  let defect = "";
  let rejected = "";
  let maxTokens = options.maxTokens;
  let fallbackActivated = false;
  let attemptsUsed = 0;
  let validationSection: SourceReviewValidationSection | undefined;
  const fallbackModel = options.outputLimitFallbackModel?.trim();
  const canFailOver = Boolean(
    fallbackModel && fallbackModel !== getExtractionReviewModel(),
  );
  const timeoutMs = configuredPositive(
    "PACKET_REVIEW_TASK_TIMEOUT_MS",
    45_000,
    120_000,
  );
  for (let attempt = 1; attempt <= 2; attempt++) {
    attemptsUsed = attempt;
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
        maxTokens,
        model: fallbackActivated ? fallbackModel : undefined,
        // This staged task owns its two bounded attempts. Do not let the lower
        // level HTTP helper replay either provider invisibly; a transient or
        // incomplete primary response must switch straight to the independent
        // fallback, and a bad fallback must return control to the workflow.
        maxRetries: 0,
        timeoutMs,
        responseSchema: {
          name: options.operation.replaceAll("-", "_"),
          strict: true,
          schema: options.schema,
        },
      });
    } catch (error) {
      if (error instanceof RequestSizeError) {
        throw new ReviewContractError(
          "This review exceeds safe request capacity and needs a smaller source scope.",
          {
            operation: options.operation,
            defect: error.message,
          },
        );
      }
      const outputLimited = error instanceof OpenRouterOutputLimitError;
      const transientResponse = isRetryableOpenRouterError(error);
      if (!outputLimited && !transientResponse) throw error;
      defect = error instanceof Error ? error.message : String(error);
      console.warn("[staged-review] task response rejected", {
        operation: options.operation,
        attempt,
        defect,
      });
      validationSection = undefined;
      if (canFailOver && !fallbackActivated) {
        fallbackActivated = true;
        maxTokens = options.maxTokens;
      } else if (outputLimited) {
        maxTokens = Math.min(32768, maxTokens * 2);
      } else {
        throw error;
      }
      rejected = "";
      continue;
    }
    try {
      rejected = raw;
      return { raw, result: options.validate(raw), attempts: attempt };
    } catch (error) {
      defect = error instanceof Error ? error.message : String(error);
      if (
        error instanceof SourceReviewValidationError &&
        error.rejectedResponse
      )
        rejected = error.rejectedResponse;
      validationSection =
        error instanceof SourceReviewValidationError
          ? error.section
          : "source-audit";
      console.warn("[staged-review] task response rejected", {
        operation: options.operation,
        attempt,
        defect,
      });
      if (
        validationSection &&
        options.stopAfterValidationSections?.includes(validationSection)
      ) {
        throw new ReviewContractError(
          `Review task ${options.operation} requires targeted repair. ${defect}`,
          {
            operation: options.operation,
            defect,
            rejected,
            validationSection,
          },
        );
      }
      if (canFailOver && !fallbackActivated) fallbackActivated = true;
    }
  }
  const attemptLabel = attemptsUsed === 2 ? "two" : String(attemptsUsed);
  throw new ReviewContractError(
    `Review task ${options.operation} could not be verified after ${attemptLabel} attempts. ${defect}`,
    {
      operation: options.operation,
      defect,
      rejected,
      validationSection,
    },
  );
}

const SOURCE_REVIEW_INSTRUCTION =
  "You are the Pro source-reviewer for ONE document. Return ONLY the required compact JSON. " +
  "Read its original pages; first-pass fields are untrusted proposals. The original page images are the source of truth. " +
  "Every pageNumber is a supplied sourcePagePointers pointer such as p1, NOT an integer. The app binds it to the exact original page. Do not use local numbers or an extracted table's sourcePage. " +
  'The response structure is {"sourceVerdict":"verified|needs_review","fieldChecks":{"requestedField":"supported|unsupported"},"lineItemChecks":{"requestedProperty":"supported|unsupported"},"references":{"canonicalReferenceField":{"value":"literal printed value or null","sourceLabel":"literal label","valueKind":"reference|document_type|date|party|other|absent|unreadable","pageNumber":"supplied pointer","quote":"literal own-page label and value"}},"newReferences":[],"fieldChanges":[{"field":"canonical non-reference field","value":"source-based value","evidenceKind":"printed|visual_observation","pageNumber":"supplied pointer","quote":"literal own-page words"}],"removalEvidence":null,"structureChange":null,"pageQuality":[{"pageNumber":"supplied pointer","issues":[],"approvalSafe":true,"confidence":"high|medium|low","reason":"visual assessment"}],"reviewIssues":[],"reason":"source-based explanation"}. This is a shape guide, not findings: inspect the pixels to fill every nested evidence and quality property; never return empty evidence objects. references can be {} when no references exist. Empty arrays mean no entries, not one empty object. ' +
  "Check EVERY populated field and every populated line-item property, and inspect for omitted, explicitly labelled values. " +
  "Independently inventory commercial goods/service rows from ALL original pages in tableCoverage, even when first-pass lineItems is empty. status complete requires one own-page quote per goods/service row in rows, in the same order as the final lineItems. Include a brief own-page evidence quote explaining the table assessment. Totals, taxes, delivery allocations, repeated copies and supporting references are not additional invoice products. not_present means the source truly has no commercial rows, not that extraction returned none. unreadable requires sourceVerdict needs_review. " +
  "Read the source column headings and billing basis to distinguish billable quantity from package/piece counts and shipment weights. A piece count and a weight describing the SAME commercial row are not separate products. Preserve genuine separate rows even when their codes repeat. If the source is ambiguous, declare unreadable/needs_review rather than choosing by numeric size, code similarity or an assumed unit. Correct erroneous first-pass row structure using complete source-backed structureChange.lineItems. " +
  "If any source row is missing, including an entirely omitted table, recover the COMPLETE source table in structureChange.lineItems with own-page evidence in this response. Never borrow products or quantities from another document. Confirm codes/descriptions, quantity, unit, unit price and amounts directly from the source; preserve absent fields as absent. " +
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
  "Assess EVERY supplied page. The supplied view may already have been rotated into its natural reading orientation by a separate visual model; that corrected orientation is not a quality defect. Faint, blurred, cropped or unreadable content still needs the corresponding quality warning and approvalSafe false. " +
  "Use reviewIssues only for unresolved source findings with printed evidence; no invented business conflicts. " +
  "Return all required arrays, using empty arrays where appropriate. Keep reasons brief and do not include document IDs or filenames: the task binds its own source pointers.";

const SOURCE_REFERENCE_REPAIR_INSTRUCTION =
  "You are repairing ONLY the reference ledger for one source document after its full audit failed validation. " +
  "Return exactly the requested references and newReferences JSON. Re-read the supplied original page images. " +
  "For each original candidate, decide from its printed label and layout whether it is truly that reference field. " +
  "If it is, use valueKind reference and copy the literal printed value, literal label, page pointer and a brief quote containing both. " +
  "If it is actually a heading, date, party, document type, unrelated ID, absent or unreadable, return value null and the corresponding valueKind. " +
  "Do not infer from formats, filenames or other documents. Do not return any non-reference audit fields.";

const SOURCE_FIELD_CHANGES_REPAIR_INSTRUCTION =
  "You are repairing ONLY the non-reference fieldChanges for one source document after its full audit failed validation. " +
  "Return exactly one fieldChanges array and no other audit properties. Re-read the supplied original page images. " +
  "Keep only actual additions or corrections that are visibly supported on this source. " +
  "For printed evidence, copy the value verbatim from a brief own-page quote that contains that exact value; do not normalize units, punctuation, percentages, dates or numbers. " +
  "For visual_observation evidence, use it only for fields whose supplied field meaning declares that evidence kind. " +
  "If a proposed change is unnecessary, inferred, absent, unreadable or cannot be paired with exact own-page evidence, omit it. An empty fieldChanges array is valid. " +
  "Do not return references, support votes, quality findings, structure changes or any other audit fields.";

const SOURCE_AUDIT_REPAIR_KEYS = [
  "sourceVerdict",
  "fieldChecks",
  "lineItemChecks",
  "tableCoverage",
  "removalEvidence",
  "structureChange",
  "pageQuality",
  "reviewIssues",
  "reason",
] as const;

const SOURCE_AUDIT_REPAIR_INSTRUCTION =
  "You are repairing ONLY the source-audit consistency for one document after its full audit failed validation. " +
  "Return exactly sourceVerdict, fieldChecks, lineItemChecks, tableCoverage, removalEvidence, structureChange, pageQuality, reviewIssues and reason. Re-read the supplied original page images. " +
  "Independently inventory every commercial goods/service row in tableCoverage.rows with its own-page quote. Complete coverage must correspond one-to-one, in order, to the final saved rows; recover any missing rows in structureChange.lineItems from this source only. Do not count tax totals or delivery allocation subrows as additional invoice goods. not_present requires genuinely no commercial rows; unreadable requires sourceVerdict needs_review. Supply tableCoverage.evidence explaining the assessment. Never lower the inventory merely to fit an incomplete extraction. " +
  "Return one support vote for every supplied field and line-item property. A supported vote means the current value is visibly supported by this source. " +
  "An unsupported vote removes the current value and therefore requires a brief own-page removalEvidence quote showing why that value is not supported; if the source does not prove removal, mark it supported instead. " +
  "Keep structureChange null unless the document type or table truly needs a source-proved correction. Do not repeat a table merely to remove properties selected by unsupported votes. " +
  "Keep all quality findings and review issues tied to literal evidence on this source. Do not return references, newReferences or fieldChanges.";

function parseObjectOrNull(raw: string) {
  try {
    return object(JSON.parse(raw));
  } catch {
    return null;
  }
}

function retainGroundedPacketIssues(
  raw: unknown,
  documents: CaseDoc[],
  pages: ReviewSourcePage[],
) {
  if (!Array.isArray(raw))
    throw new Error("Packet review issues must be an array.");
  const retained: unknown[] = [];
  let discarded = 0;
  for (const issue of raw) {
    try {
      // Packet issues are optional discoveries. Validate them independently so
      // one ungrounded proposal cannot erase an otherwise verified grouping,
      // source ledger, or primary invoice reference.
      parseGroundedReviewIssues([issue], documents, pages, "packet-check");
      retained.push(issue);
    } catch (error) {
      discarded++;
      console.warn("[staged-review] discarded ungrounded packet issue", {
        defect: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { retained, discarded };
}

function unverifiedSourceReview(document: CaseDoc, pages: ReviewSourcePage[]) {
  const reason =
    "Automated source verification returned an internally inconsistent result. The original extraction was preserved without applying any unverified correction.";
  return {
    document: {
      ...document,
      tableCoverage: { status: "unverified" as const, rows: [] },
    },
    audit: {
      docId: document.id,
      status: "needs_review" as const,
      supportedFields: [],
      unsupportedFields: [],
      visibleOmittedFields: [],
      supportedLineItemProperties: [],
      unsupportedLineItemProperties: [],
      reason,
      referenceEvidence: [],
    },
    pageQuality: pages.map((page) => ({
      sourceFileName: page.sourceFileName,
      pageNumber: page.pageNumber,
      documentId: document.id,
      issues: [],
      approvalSafe: false,
      confidence: "low" as const,
      reason,
    })),
    summary: {
      enabled: true,
      required: true,
      authoritative: true,
      semanticPostProcessing: false,
      model: getExtractionReviewModel(),
      provider: getExtractionReviewProvider(),
      reasoningEffort: getExtractionReviewReasoningEffort(),
      reviewedAt: new Date().toISOString(),
      verdict: "needs_review" as const,
      correctionCount: 0,
      reviewIssueCount: 1,
      corrections: [],
      warnings: [reason],
      error: reason,
    },
    reviewIssues: [
      {
        id: `evidence-review-source-contract-${document.id}`,
        field: EXTRACTION_VERIFICATION_FIELD,
        values: [
          {
            docId: document.id,
            value: "Source verification needs review",
            sourceFileName: document.sourceFileName,
          },
        ],
        analysis: reason,
        fixPlan:
          "Open the original source pages and verify the extracted values before approval. Re-run analysis to obtain a fresh automated review.",
      },
    ] satisfies Mismatch[],
  };
}

function deferredWorkflowReviewIssue(
  stage: "packet" | "decisions" | "root-causes",
  documents: CaseDoc[],
): Mismatch {
  const labels = {
    packet: "Packet reconciliation",
    decisions: "Mismatch verification",
    "root-causes": "Mismatch consolidation",
  } as const;
  const label = labels[stage];
  return {
    id: `evidence-review-workflow-${stage}`,
    field: EXTRACTION_VERIFICATION_FIELD,
    values: documents.map((document) => ({
      docId: document.id,
      value: `${label} needs review`,
      sourceFileName: document.sourceFileName,
    })),
    analysis: `${label} returned an internally inconsistent result. Verified source data was preserved and no rejected decision was applied.`,
    fixPlan:
      "Review the original packet evidence before approval, then re-run analysis to obtain a fresh automated decision.",
  };
}

async function reviewOneSource(options: {
  document: CaseDoc;
  pages: ReviewSourcePage[];
  store?: ReviewCheckpointStore;
  recheckReason?: string;
  referenceQuarantineAttempted?: boolean;
}): Promise<{
  result:
    | ReturnType<typeof parseCompactSourceAudit>
    | ReturnType<typeof unverifiedSourceReview>;
  reused: boolean;
  attempts: number;
  key: string;
}> {
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
  const validateMerged = (raw: string) => {
    try {
      return validate(raw);
    } catch (error) {
      if (error instanceof SourceReviewValidationError)
        throw new SourceReviewValidationError(
          error.section,
          error.message,
          raw,
        );
      throw new SourceReviewValidationError(
        "source-audit",
        error instanceof Error ? error.message : String(error),
        raw,
      );
    }
  };
  const pending = cachedReviewStage({
    key,
    store: options.store,
    validate,
    run: async () => {
      const sourceMessages: OpenRouterMessage[] = [
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
      ];
      try {
        return await completeReviewRequest({
          operation: "source-document-review",
          validate,
          outputLimitFallbackModel: getExtractionReviewFallbackModel(),
          stopAfterValidationSections: [
            "references",
            "field-changes",
            "source-audit",
            "review-issues",
          ],
          maxTokens: configuredPositive(
            "PACKET_SOURCE_REVIEW_MAX_OUTPUT_TOKENS",
            8192,
            32768,
          ),
          schema: buildSourceAuditSchema(options.document, options.pages),
          messages: sourceMessages,
        });
      } catch (error) {
        const repairResponse = async (error: unknown) => {
          if (
            !(error instanceof ReviewContractError) ||
            !error.rejected ||
            !error.validationSection
          )
            throw error;
          const rejected = parseObjectOrNull(error.rejected);
          if (!rejected) throw error;
          if (error.validationSection === "review-issues") {
            const repaired = await completeReviewRequest({
              operation: "source-issues-repair",
              stopAfterValidationSections: [
                "references",
                "field-changes",
                "source-audit",
              ],
              outputLimitFallbackModel: getExtractionReviewFallbackModel(),
              schema: buildSourceIssuesRepairSchema(
                options.document,
                options.pages,
              ),
              maxTokens: configuredPositive(
                "PACKET_SOURCE_REVIEW_MAX_OUTPUT_TOKENS",
                8192,
                32768,
              ),
              messages: [
                {
                  role: "system",
                  content:
                    "Review ONLY the proposed unresolved findings against the supplied original page images. Return exactly {reviewIssues: [...]}. " +
                    "Use only canonical fields allowed by the schema, a source-grounded reason, and evidence with a supplied own-page pointer and a literal quote containing the exact value. " +
                    "Do not invent evidence, infer values, or change source fields, table coverage, support votes or page quality. " +
                    "Remove unsupported proposed findings; return an empty array only when the source proves that none of the proposals is an unresolved finding.",
                },
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        validationDefect: error.defect,
                        document: context.document,
                        proposedIssues: rejected.reviewIssues,
                        sourcePagePointers: context.sourcePagePointers,
                      }),
                    },
                    ...options.pages.flatMap((page, index) => [
                      {
                        type: "text" as const,
                        text: `Own page pointer p${index + 1} (original page ${page.pageNumber})`,
                      },
                      {
                        type: "image_url" as const,
                        image_url: { url: page.image },
                      },
                    ]),
                  ],
                },
              ],
              validate: (raw) => {
                const patch = object(JSON.parse(raw));
                if (
                  Object.keys(patch).length !== 1 ||
                  !Object.hasOwn(patch, "reviewIssues")
                )
                  throw new SourceReviewValidationError(
                    "review-issues",
                    "Finding repair may only return reviewIssues.",
                  );
                const merged = JSON.stringify({
                  ...rejected,
                  reviewIssues: patch.reviewIssues,
                });
                return { raw: merged, result: validateMerged(merged) };
              },
            });
            return {
              raw: repaired.result.raw,
              result: repaired.result.result,
              attempts: 1 + repaired.attempts,
            };
          }
          if (error.validationSection === "field-changes") {
            const repairContext = {
              validationDefect: error.defect,
              currentFields: options.document.fields,
              proposedFieldChanges: rejected.fieldChanges,
              fieldMeanings: context.fieldMeanings,
              sourcePagePointers: context.sourcePagePointers,
            };
            const repaired = await completeReviewRequest({
              operation: "source-field-changes-repair",
              stopAfterValidationSections: [
                "references",
                "source-audit",
                "review-issues",
              ],
              outputLimitFallbackModel: getExtractionReviewFallbackModel(),
              schema: buildSourceFieldChangesRepairSchema(
                options.document,
                options.pages,
              ),
              maxTokens: configuredPositive(
                "PACKET_SOURCE_REVIEW_MAX_OUTPUT_TOKENS",
                8192,
                32768,
              ),
              messages: [
                {
                  role: "system",
                  content: SOURCE_FIELD_CHANGES_REPAIR_INSTRUCTION,
                },
                {
                  role: "user",
                  content: [
                    { type: "text", text: JSON.stringify(repairContext) },
                    ...options.pages.flatMap((page, index) => [
                      {
                        type: "text" as const,
                        text: `Own page pointer p${index + 1} (original page ${page.pageNumber})`,
                      },
                      {
                        type: "image_url" as const,
                        image_url: { url: page.image },
                      },
                    ]),
                  ],
                },
              ],
              validate: (raw) => {
                const patch = object(JSON.parse(raw));
                if (
                  Object.keys(patch).some((key) => key !== "fieldChanges") ||
                  !Object.hasOwn(patch, "fieldChanges")
                )
                  throw new Error(
                    "Field-change repair returned fields outside its repair contract.",
                  );
                const merged = JSON.stringify({
                  ...rejected,
                  fieldChanges: patch.fieldChanges,
                });
                return { raw: merged, result: validateMerged(merged) };
              },
            });
            return {
              raw: repaired.result.raw,
              result: repaired.result.result,
              attempts: 1 + repaired.attempts,
            };
          }
          if (error.validationSection === "source-audit") {
            const proposedAudit = Object.fromEntries(
              SOURCE_AUDIT_REPAIR_KEYS.map((key) => [key, rejected[key]]),
            );
            const repairContext = {
              validationDefect: error.defect,
              document: context.document,
              fieldChecksInOrder: context.fieldChecksInOrder,
              lineItemChecksInOrder: context.lineItemChecksInOrder,
              sourcePagePointers: context.sourcePagePointers,
              proposedAudit,
            };
            const repaired = await completeReviewRequest({
              operation: "source-audit-repair",
              stopAfterValidationSections: [
                "references",
                "field-changes",
                "review-issues",
              ],
              outputLimitFallbackModel: getExtractionReviewFallbackModel(),
              schema: buildSourceAuditRepairSchema(
                options.document,
                options.pages,
              ),
              maxTokens: configuredPositive(
                "PACKET_SOURCE_REVIEW_MAX_OUTPUT_TOKENS",
                8192,
                32768,
              ),
              messages: [
                { role: "system", content: SOURCE_AUDIT_REPAIR_INSTRUCTION },
                {
                  role: "user",
                  content: [
                    { type: "text", text: JSON.stringify(repairContext) },
                    ...options.pages.flatMap((page, index) => [
                      {
                        type: "text" as const,
                        text: `Own page pointer p${index + 1} (original page ${page.pageNumber})`,
                      },
                      {
                        type: "image_url" as const,
                        image_url: { url: page.image },
                      },
                    ]),
                  ],
                },
              ],
              validate: (raw) => {
                const patch = object(JSON.parse(raw));
                if (
                  Object.keys(patch).length !==
                    SOURCE_AUDIT_REPAIR_KEYS.length ||
                  Object.keys(patch).some(
                    (key) =>
                      !SOURCE_AUDIT_REPAIR_KEYS.includes(
                        key as (typeof SOURCE_AUDIT_REPAIR_KEYS)[number],
                      ),
                  ) ||
                  SOURCE_AUDIT_REPAIR_KEYS.some(
                    (key) => !Object.hasOwn(patch, key),
                  )
                )
                  throw new Error(
                    "Source-audit repair returned fields outside its repair contract.",
                  );
                const merged = JSON.stringify({ ...rejected, ...patch });
                return { raw: merged, result: validateMerged(merged) };
              },
            });
            return {
              raw: repaired.result.raw,
              result: repaired.result.result,
              attempts: 1 + repaired.attempts,
            };
          }
          const repairContext = {
            validationDefect: error.defect,
            referencesToReview: context.referencesToReview,
            originalReferenceValues: Object.fromEntries(
              context.referencesToReview.map((field) => [
                field,
                options.document.fields[field],
              ]),
            ),
            sourcePagePointers: context.sourcePagePointers,
          };
          const repaired = await completeReviewRequest({
            operation: "source-reference-repair",
            stopAfterValidationSections: [
              "field-changes",
              "source-audit",
              "review-issues",
            ],
            outputLimitFallbackModel: getExtractionReviewFallbackModel(),
            schema: buildSourceReferenceRepairSchema(
              options.document,
              options.pages,
            ),
            maxTokens: configuredPositive(
              "PACKET_SOURCE_REVIEW_MAX_OUTPUT_TOKENS",
              8192,
              32768,
            ),
            messages: [
              { role: "system", content: SOURCE_REFERENCE_REPAIR_INSTRUCTION },
              {
                role: "user",
                content: [
                  { type: "text", text: JSON.stringify(repairContext) },
                  ...options.pages.flatMap((page, index) => [
                    {
                      type: "text" as const,
                      text: `Own page pointer p${index + 1} (original page ${page.pageNumber})`,
                    },
                    {
                      type: "image_url" as const,
                      image_url: { url: page.image },
                    },
                  ]),
                ],
              },
            ],
            validate: (raw) => {
              const patch = object(JSON.parse(raw));
              if (
                Object.keys(patch).some(
                  (key) => key !== "references" && key !== "newReferences",
                ) ||
                !Object.hasOwn(patch, "references") ||
                !Object.hasOwn(patch, "newReferences")
              )
                throw new Error(
                  "Reference repair returned fields outside its repair contract.",
                );
              const merged = JSON.stringify({
                ...rejected,
                references: patch.references,
                newReferences: patch.newReferences,
              });
              return { raw: merged, result: validateMerged(merged) };
            },
          });
          return {
            raw: repaired.result.raw,
            result: repaired.result.result,
            attempts: 1 + repaired.attempts,
          };
        };
        const repairedSections = new Set<SourceReviewValidationSection>();
        let failure: unknown = error;
        let attempts = 1;
        while (
          failure instanceof ReviewContractError &&
          failure.validationSection
        ) {
          const section = failure.validationSection;
          if (repairedSections.has(section)) throw failure;
          repairedSections.add(section);
          try {
            const repaired = await repairResponse(failure);
            return { ...repaired, attempts: attempts + repaired.attempts - 1 };
          } catch (next) {
            attempts += 2;
            failure = next;
          }
        }
        throw failure;
      }
    },
  });
  try {
    const cached = await pending;
    return { ...cached, key };
  } catch (error) {
    if (!(error instanceof ReviewContractError)) throw error;
    if (
      error.validationSection === "references" &&
      error.rejected &&
      !options.referenceQuarantineAttempted
    ) {
      let isolated: ReturnType<
        typeof isolateUnverifiedSourceReferences
      > | null = null;
      try {
        isolated = isolateUnverifiedSourceReferences(
          error.rejected,
          options.document,
          options.pages,
        );
      } catch {
        // A malformed container cannot be treated as independent reference
        // evidence. Preserve the normal approval/matching block below.
      }
      if (isolated?.quarantined.length) {
        const independent = await reviewOneSource({
          ...options,
          document: isolated.document,
          referenceQuarantineAttempted: true,
          recheckReason: `The previous reference proofs for ${isolated.quarantined.join(", ")} could not be validated and those unverified proposals were quarantined. Independently verify this source's retained fields and complete commercial table. Restore a quarantined reference only if its exact printed value and own-page proof can now be supplied. Do not infer missing values.`,
        });
        const unresolved = isolated.quarantined.filter(
          (field) =>
            !independent.result.audit.referenceEvidence.some(
              (proof) =>
                proof.field === field &&
                proof.value === independent.result.document.fields[field],
            ),
        );
        if (!unresolved.length) return independent;
        const reason = `Reference verification needs manual review: ${unresolved.join(", ")}. Other source data was independently re-reviewed; no unverified reference was accepted.`;
        const deferred = unverifiedSourceReview(
          options.document,
          options.pages,
        );
        return {
          ...independent,
          result: {
            ...independent.result,
            audit: {
              ...independent.result.audit,
              status: "needs_review" as const,
              reason,
            },
            summary: {
              ...independent.result.summary,
              verdict: "needs_review" as const,
              warnings: [...independent.result.summary.warnings, reason],
            },
            reviewIssues: [
              ...independent.result.reviewIssues,
              ...deferred.reviewIssues.map((issue) => ({
                ...issue,
                id: `evidence-review-reference-quarantine-${options.document.id}`,
                analysis: reason,
                fixPlan:
                  "Verify the named reference against the original source page before approval.",
              })),
            ],
          },
        };
      }
    }
    if (error.validationSection === "review-issues" && error.rejected) {
      const rejected = parseObjectOrNull(error.rejected);
      if (rejected) {
        // Independently revalidate ALL source fields, references, table rows,
        // corrections and page quality. Never infer their validity from the
        // failure category or apply an invalid finding. Approval remains blocked.
        try {
          const verified = validate(
            JSON.stringify({ ...rejected, reviewIssues: [] }),
          );
          const retainedIssues: Mismatch[] = [];
          if (Array.isArray(rejected.reviewIssues)) {
            for (const [index, issue] of rejected.reviewIssues.entries()) {
              try {
                const independent = validate(
                  JSON.stringify({ ...rejected, reviewIssues: [issue] }),
                );
                retainedIssues.push(
                  ...independent.reviewIssues.map((finding) => ({
                    ...finding,
                    id: `evidence-review-source:${options.document.id}-${index + 1}`,
                  })),
                );
              } catch {
                // The unvalidated proposal is represented by the explicit
                // review blocker, never presented as a factual mismatch.
              }
            }
          }
          const deferred = unverifiedSourceReview(
            options.document,
            options.pages,
          );
          const reason =
            "The source data was verified, but an unresolved review finding could not be validated. Review the original page before approval.";
          return {
            result: {
              ...verified,
              audit: {
                ...verified.audit,
                status: "needs_review" as const,
                reason,
              },
              summary: {
                ...verified.summary,
                verdict: "needs_review" as const,
                warnings: [...verified.summary.warnings, reason],
              },
              reviewIssues: [
                ...retainedIssues,
                ...deferred.reviewIssues.map((issue) => ({
                  ...issue,
                  analysis: reason,
                })),
              ],
            },
            reused: false,
            attempts: 3,
            key,
          };
        } catch {
          // If any source-data contract also fails, retain the original
          // fail-closed behavior below; table coverage cannot be assumed.
        }
      }
    }
    // A model-contract failure is not evidence that the user's document is
    // wrong. Preserve the original extraction, block approval with an explicit
    // review item, and allow the remaining packet analysis to finish. Never
    // salvage or apply the rejected response.
    console.warn("[staged-review] source verification deferred", {
      documentId: options.document.id,
      operation: error.operation,
      defect: error.defect,
    });
    return {
      result: unverifiedSourceReview(options.document, options.pages),
      reused: false,
      attempts: 2,
      key,
    };
  }
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
  const workflowReviewIssues: Mismatch[] = [];
  const correctionHistory = sourceReviews.flatMap(
    (result) => result.summary.corrections,
  );
  const currentDocuments = sourceReviews.map((result) => result.document);
  let candidates: Mismatch[] = [];
  let packetRaw: Record<string, unknown> | undefined;
  let packetContext: Record<string, unknown> = {};
  let aliases = packetPointerAliases(currentDocuments);
  let pageEvidence: Promise<PageEvidence[]> | undefined;
  const boundedPacketMessages = async (
    messages: OpenRouterMessage[],
    schema: Record<string, unknown>,
    maxTokens: number,
  ): Promise<OpenRouterMessage[]> => {
    // Reserve space for repair instructions/rejected output on the second attempt.
    if (
      Buffer.byteLength(
        reviewRequestBody(messages, schema, maxTokens),
        "utf8",
      ) <=
      requestByteLimit() - 1_000_000
    )
      return messages;
    pageEvidence ??= (async () => {
      await report(94, "Checking page evidence in smaller batches");
      let batches: ReturnType<typeof packetEvidenceBatches>;
      try {
        batches = packetEvidenceBatches(options.sourcePages);
      } catch (error) {
        if (!(error instanceof RequestSizeError)) throw error;
        throw new ReviewContractError(
          "A source page exceeds safe evidence capacity; source review is required.",
        );
      }
      const results = await mapReviewTasks(
        batches,
        concurrency,
        async (batch) => {
          const response = await cachedReviewStage({
            key: reviewCheckpointKey("packet", {
              kind: "page-evidence",
              sources: sourceFingerprint(batch),
              pointers: batch.map((page) => page.pointer),
              settings: modelSettings(),
            }),
            store: options.checkpoints,
            validate: (raw) => validatePageEvidence(raw, batch),
            run: () =>
              completeReviewRequest({
                operation: "packet-page-evidence",
                schema: PAGE_EVIDENCE_SCHEMA,
                messages: pageEvidenceMessages(batch),
                maxTokens: 16384,
                outputLimitFallbackModel: getExtractionReviewFallbackModel(),
                validate: (raw) => validatePageEvidence(raw, batch),
              }),
          });
          return response.result;
        },
      );
      return results.flat();
    })();
    const ledger = await pageEvidence;
    if (ledger.some((entry) => !entry.readable))
      throw new ReviewContractError(
        "Page evidence is unreadable; source review is required.",
      );
    let imageIndex = 0;
    const bounded = messages.map((message): OpenRouterMessage => ({
      ...message,
      content:
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) => {
              if (part.type !== "image_url") return part;
              const evidence = ledger[imageIndex];
              if (
                !evidence ||
                options.sourcePages[imageIndex]?.image !== part.image_url.url
              )
                throw new ReviewContractError(
                  "Source image has no completed evidence batch.",
                );
              imageIndex++;
              return {
                type: "text",
                text: `Source-page evidence (read from original pixels in a completed batch): ${evidence.evidence}`,
              };
            }),
    }));
    if (imageIndex !== options.sourcePages.length)
      throw new ReviewContractError(
        "Packet evidence does not cover all original pages.",
      );
    bounded.push({
      role: "user",
      content:
        "Original pages were read in byte-bounded batches. Use their page-labelled evidence with the independently verified source audits and fields for the whole-packet comparison. Do not treat omitted evidence as absence. If a source finding is uncertain, request its source recheck; never invent a quote or accept an unverified value.",
    });
    if (
      Buffer.byteLength(reviewRequestBody(bounded, schema, maxTokens), "utf8") >
      requestByteLimit() - 1_000_000
    )
      throw new ReviewContractError(
        "Verified packet context exceeds safe capacity; manual source review is required.",
      );
    return bounded;
  };
  let packetAttempts = 0;
  let discardedPacketIssueCount = 0;
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
    const requests = payload.sourceRecheckRequests
      .map((value) => {
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
      })
      // A source already marked needs_review has no verified finding to
      // contradict. Re-running the same pages cannot make an invalid model
      // contract safer; its existing review item keeps approval blocked.
      .filter(
        (request) =>
          sourceReviews.find((result) => result.document.id === request.docId)
            ?.audit.status !== "needs_review",
      );
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
    const packetIssues = retainGroundedPacketIssues(
      payload.packetIssues,
      currentDocuments,
      options.sourcePages,
    );
    return {
      payload: { ...payload, packetIssues: packetIssues.retained },
      requests,
      discardedPacketIssueCount: packetIssues.discarded,
    };
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
        })),
        sourceAudits: sourceReviews.map((result) => ({
          ...result.audit,
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
    let packetResult: {
      result: ReturnType<typeof parsePacket>;
      reused: boolean;
      attempts: number;
    };
    const packetReview = cachedReviewStage({
      key,
      store: options.checkpoints,
      validate: parsePacket,
      cacheWhen: (result) => result.requests.length === 0,
      run: async () => {
        const result = await completeReviewRequest({
          operation: "packet-reconciliation",
          validate: parsePacket,
          outputLimitFallbackModel: getExtractionReviewFallbackModel(),
          schema: packetTaskSchema(currentDocuments, options.sourcePages),
          messages: await boundedPacketMessages(
            messages,
            packetTaskSchema(currentDocuments, options.sourcePages),
            8192,
          ),
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
    try {
      packetResult = await packetReview;
    } catch (error) {
      if (!(error instanceof ReviewContractError)) throw error;
      console.warn("[staged-review] packet reconciliation deferred", {
        operation: error.operation,
        defect: error.defect,
      });
      workflowReviewIssues.push(
        deferredWorkflowReviewIssue("packet", currentDocuments),
      );
      packetRaw = {
        packetGroups: [
          {
            label: "Packet requires review",
            documentIds: currentDocuments.map((document) => document.id),
            relationship: "standard",
            primaryDocumentIds: [],
            contextDocumentIds: [],
            rationale:
              "Automated packet reconciliation was deferred without applying an unverified grouping decision.",
            caseSummary: {
              counterpartySource: null,
              poNumber: "",
              invoiceNumber: "",
              primaryReference: "",
              packetCategory: "Packet under review",
            },
          },
        ],
        termsChecklist: [],
        sourceRecheckRequests: [],
        packetIssues: [],
        notes: [],
      };
      break;
    }
    const result = packetResult;
    if (result.reused) reused++;
    discardedPacketIssueCount = Math.max(
      discardedPacketIssueCount,
      result.result.discardedPacketIssueCount,
    );
    packetRaw = result.result.payload;
    if (!result.result.requests.length) break;
    if (pass === 1) {
      workflowReviewIssues.push(
        deferredWorkflowReviewIssue("packet", currentDocuments),
      );
      packetRaw = { ...packetRaw, sourceRecheckRequests: [] };
      break;
    }
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
  let rootCauseAttempts = 0;
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
      let result: {
        result: ReturnType<typeof validate>;
        reused: boolean;
        attempts: number;
      };
      const decisionReview = cachedReviewStage({
        key,
        store: options.checkpoints,
        validate,
        run: async () => {
          const result = await completeReviewRequest({
            operation: "packet-mismatch-decisions",
            validate,
            outputLimitFallbackModel: getExtractionReviewFallbackModel(),
            schema,
            maxTokens: configuredPositive(
              "PACKET_DECISION_REVIEW_MAX_OUTPUT_TOKENS",
              6144,
              32768,
            ),
            messages: await boundedPacketMessages(
              [
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
              schema,
              6144,
            ),
          });
          decisionAttempts += result.attempts;
          return result;
        },
      });
      try {
        result = await decisionReview;
      } catch (error) {
        if (!(error instanceof ReviewContractError)) throw error;
        console.warn("[staged-review] mismatch decisions deferred", {
          operation: error.operation,
          defect: error.defect,
        });
        if (
          !workflowReviewIssues.some(
            (issue) => issue.id === "evidence-review-workflow-decisions",
          )
        )
          workflowReviewIssues.push(
            deferredWorkflowReviewIssue("decisions", currentDocuments),
          );
        return batch.candidates.map((_, index) => ({
          mismatchId: `mismatch-${batch.offset + index + 1}`,
          status: "dismissed",
          primary: false,
          outlierDocumentIds: [],
          reason:
            "Automated mismatch verification was deferred; no unverified discrepancy was applied.",
        }));
      }
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
  // Packet reconciliation can discover source-proved conflicts that were not
  // present in the deterministic candidate set. They must enter the same final
  // root-cause review as confirmed candidates; otherwise symptoms discovered
  // here would bypass consolidation and be saved beside their root cause.
  const packetReviewIssues = parseGroundedReviewIssues(
    packetRaw.packetIssues,
    currentDocuments,
    options.sourcePages,
    "packet",
  );
  const rootCauseCandidates = buildRootCauseCandidates([
    ...result.authoritativeReview.mismatches,
    ...packetReviewIssues,
  ]);
  if (rootCauseCandidates.length) {
    await report(96, "Validating the root cause of every packet issue");
    const rootContext = object(
      aliases.encode({
        contractVersion: STAGED_REVIEW_CONTRACT_VERSION,
        documents: currentDocuments.map((document) => ({
          docId: document.id,
          documentType: document.type,
          title: document.title,
          fields: document.fields,
          lineItems: document.lineItems ?? [],
        })),
        packetReconciliation: packetRaw,
        confirmedCandidates: rootCauseCandidates.map((candidate) => ({
          mismatchId: candidate.reviewId,
          field: candidate.mismatch.field,
          values: candidate.mismatch.values,
          analysis: candidate.mismatch.analysis,
        })),
      }),
    );
    const validateRoot = (raw: string) =>
      validateRootCauseReview(
        aliases.decode(JSON.parse(raw)),
        rootCauseCandidates,
      );
    const rootReview = cachedReviewStage({
      key: reviewCheckpointKey("root-causes", {
        context: rootContext,
        sources: sourceFingerprint(options.sourcePages),
        settings: modelSettings(),
      }),
      store: options.checkpoints,
      validate: validateRoot,
      run: async () => {
        const reviewed = await completeReviewRequest({
          operation: "packet-mismatch-root-causes",
          validate: validateRoot,
          outputLimitFallbackModel: getExtractionReviewFallbackModel(),
          schema: ROOT_CAUSE_REVIEW_SCHEMA,
          maxTokens: configuredPositive(
            "PACKET_ROOT_CAUSE_MAX_OUTPUT_TOKENS",
            6144,
            32768,
          ),
          messages: await boundedPacketMessages(
            [
              {
                role: "system",
                content:
                  "You are the final Pro root-cause reviewer. Review every confirmed candidate together against the original pages and return only the required JSON. " +
                  "Account for every candidate exactly once: retain it as an independent field_discrepancy, combine symptoms caused by the same unrelated document into one unrelated_document issue, or dismiss it with a source-based reason. " +
                  "Group candidates only when the same identified outlier document conflicts with corroborating packet documents. Choose the business cause as primary; do not present its field symptoms as separate issues. " +
                  "Document roles are semantic: a manufacturer, processor, transporter, seller and buyer can legitimately have different names. Dismiss party-name candidates that compare different roles or harmless legal-name variants. " +
                  "Dismiss OCR uncertainty, formatting differences and derivative symptoms. Never infer identity from filename, identifier format, spelling similarity, regex patterns or a customer-specific name. " +
                  "For unrelated_document, cite the exact outlier document IDs and include only candidates that contain both that outlier and corroborating evidence. Keep titles and reasons brief and client-readable.",
              },
              {
                role: "user",
                content: [
                  { type: "text", text: JSON.stringify(rootContext) },
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
            ROOT_CAUSE_REVIEW_SCHEMA,
            6144,
          ),
        });
        rootCauseAttempts += reviewed.attempts;
        return reviewed;
      },
    });
    try {
      const rootResult = await rootReview;
      if (rootResult.reused) reused++;
      result.authoritativeReview.mismatches = materializeRootCauseMismatches(
        rootResult.result,
        rootCauseCandidates,
      );
      result.confirmedMismatchCount =
        result.authoritativeReview.mismatches.length;
      result.dismissedMismatchCount +=
        rootResult.result.dismissedMismatchIds.length;
    } catch (error) {
      if (!(error instanceof ReviewContractError)) throw error;
      console.warn("[staged-review] root-cause consolidation deferred", {
        operation: error.operation,
        defect: error.defect,
      });
      workflowReviewIssues.push(
        deferredWorkflowReviewIssue("root-causes", currentDocuments),
      );
      // Keep every already verified mismatch instead of replacing it with an
      // unverified consolidation response.
      result.authoritativeReview.mismatches = rootCauseCandidates.map(
        (candidate) => ({
          ...candidate.mismatch,
          analysis:
            candidate.mismatch.analysis ??
            "The verified mismatch was retained for review without unverified consolidation.",
        }),
      );
      result.confirmedMismatchCount =
        result.authoritativeReview.mismatches.length;
    }
  }
  const pageQuality = sourceReviews.flatMap((result) => result.pageQuality);
  const reviewIssues = [
    ...sourceReviews.flatMap((result) => result.reviewIssues),
    ...workflowReviewIssues,
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
    attemptCount:
      sourceAttempts + packetAttempts + decisionAttempts + rootCauseAttempts,
    candidateMismatchCount: candidates.length,
    confirmedMismatchCount: result.confirmedMismatchCount,
    dismissedMismatchCount: result.dismissedMismatchCount,
    termsChecklistCount: result.authoritativeReview.termsChecklist.length,
    packetGroupCount: result.authoritativeReview.verificationGroups.length,
    documentAudits: sourceReviews.map((result) => result.audit),
    warnings: [
      ...sourceReviews.flatMap((result) => result.summary.warnings),
      ...(discardedPacketIssueCount
        ? [
            `Discarded ${discardedPacketIssueCount} ungrounded optional packet ${discardedPacketIssueCount === 1 ? "issue" : "issues"} without discarding the verified packet grouping.`,
          ]
        : []),
    ],
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
