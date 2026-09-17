import type { CaseDoc, FieldKey, Mismatch } from "../../types/pipeline";
import { FIELD_DEFINITIONS } from "../document-schema";
import {
  buildAuthoritativeReviewResponseSchema,
  buildReviewSourceSupportChecklist,
  parseValidatedSourceReview,
  type ReviewSourcePage,
} from "./pipeline";
import { REFERENCE_FIELD_DEFINITIONS } from "./semantic-grounding";

export const STAGED_REVIEW_CONTRACT_VERSION =
  "named-source-decisions-and-typed-evidence-v6";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Review response contains a malformed object.");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new Error("Review response omitted a required array.");
  return value;
}
const text = { type: "string" };

export function ownDocumentPages(document: CaseDoc, pages: ReviewSourcePage[]) {
  if (!document.sourcePageNumbers?.length)
    throw new Error(
      `Document ${document.id} has no explicit source-page provenance.`,
    );
  const own = pages.filter(
    (page) =>
      page.sourceFileName === document.sourceFileName &&
      document.sourcePageNumbers!.includes(page.pageNumber),
  );
  if (
    new Set(own.map((page) => page.pageNumber)).size !==
      new Set(document.sourcePageNumbers).size ||
    own.length !== new Set(document.sourcePageNumbers).size
  )
    throw new Error(`Original source pages are missing for ${document.id}.`);
  return own;
}

export function buildSourceAuditSchema(
  document: CaseDoc,
  pages: ReviewSourcePage[],
) {
  const pageNumber = {
    type: "string",
    enum: ownDocumentPages(document, pages).map((_, index) => `p${index + 1}`),
  };
  const ownEvidence = {
    type: "object",
    properties: { pageNumber, quote: text },
    required: ["pageNumber", "quote"],
    additionalProperties: false,
  };
  const base = object(
    buildAuthoritativeReviewResponseSchema({
      documentCount: 1,
      mismatchCount: 0,
      pageCount: pages.length,
      documents: [document],
    }).properties,
  );
  const correction = object(object(base.corrections).items);
  const correctionProperties = object(correction.properties);
  const structureProperties = {
    documentType: correctionProperties.documentType,
    lineItems: correctionProperties.lineItems,
    evidence: ownEvidence,
  };
  const quality = object(object(base.pageQuality).items);
  const qualityProperties = { ...object(quality.properties) };
  qualityProperties.pageNumber = pageNumber;
  delete qualityProperties.documentId;
  delete qualityProperties.sourceFileName;
  const referenceEntry = {
    type: "object",
    properties: {
      value: { anyOf: [text, { type: "null" }] },
      sourceLabel: text,
      valueKind: {
        type: "string",
        enum: [
          "reference",
          "document_type",
          "date",
          "party",
          "other",
          "absent",
          "unreadable",
        ],
      },
      pageNumber,
      quote: text,
    },
    required: ["value", "sourceLabel", "valueKind", "pageNumber", "quote"],
    additionalProperties: false,
  };
  const originalReferences = REFERENCE_FIELD_DEFINITIONS.filter(({ key }) =>
    String(document.fields[key] ?? "").trim(),
  ).map(({ key }) => key);
  const newReferenceKeys = REFERENCE_FIELD_DEFINITIONS.filter(
    ({ key }) => !originalReferences.includes(key),
  ).map(({ key }) => key);
  const checklist = buildReviewSourceSupportChecklist([document])[document.id];
  const supportSchema = (keys: string[]) => ({
    type: "object",
    properties: Object.fromEntries(
      keys.map((key) => [
        key,
        { type: "string", enum: ["supported", "unsupported"] },
      ]),
    ),
    required: keys,
    additionalProperties: false,
  });
  return {
    type: "object",
    properties: {
      sourceVerdict: { type: "string", enum: ["verified", "needs_review"] },
      fieldChecks: supportSchema(checklist.fieldSupport),
      lineItemChecks: supportSchema(checklist.lineItemPropertySupport),
      references: {
        type: "object",
        properties: Object.fromEntries(
          originalReferences.map((key) => [key, referenceEntry]),
        ),
        required: originalReferences,
        additionalProperties: false,
      },
      newReferences: {
        type: "array",
        items: {
          ...referenceEntry,
          properties: {
            field: {
              type: "string",
              enum: newReferenceKeys.length
                ? newReferenceKeys
                : originalReferences,
            },
            ...referenceEntry.properties,
          },
          required: ["field", ...referenceEntry.required],
        },
      },
      fieldChanges: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: {
              type: "string",
              enum: FIELD_DEFINITIONS.filter(
                ({ semanticKind }) => semanticKind !== "reference",
              ).map(({ key }) => key),
            },
            value: text,
            evidenceKind: {
              type: "string",
              enum: ["printed", "visual_observation"],
            },
            ...ownEvidence.properties,
          },
          required: ["field", "value", "evidenceKind", "pageNumber", "quote"],
          additionalProperties: false,
        },
      },
      removalEvidence: { anyOf: [{ type: "null" }, ownEvidence] },
      structureChange: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: structureProperties,
            required: ["evidence"],
            additionalProperties: false,
          },
        ],
      },
      pageQuality: {
        type: "array",
        items: {
          ...quality,
          properties: qualityProperties,
          required: (quality.required as string[]).filter(
            (key) => key !== "documentId" && key !== "sourceFileName",
          ),
        },
      },
      reviewIssues: {
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
                properties: { ...ownEvidence.properties, value: text },
                required: ["value", "pageNumber", "quote"],
                additionalProperties: false,
              },
            },
          },
          required: ["field", "reason", "evidence"],
          additionalProperties: false,
        },
      },
      reason: text,
    },
    required: [
      "sourceVerdict",
      "fieldChecks",
      "lineItemChecks",
      "references",
      "newReferences",
      "fieldChanges",
      "removalEvidence",
      "structureChange",
      "pageQuality",
      "reviewIssues",
      "reason",
    ],
    additionalProperties: false,
  };
}

function exactSupport(keys: string[], raw: unknown) {
  const verdicts =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(verdicts).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(verdicts, key)) ||
    Object.values(verdicts).some(
      (value) => value !== "supported" && value !== "unsupported",
    )
  )
    throw new Error(
      `The source audit must return exactly one verdict per supplied field key. Required: ${keys.join(", ") || "empty object"}. Received: ${Object.keys(verdicts).join(", ") || "none"}.`,
    );
  return verdicts;
}

// Filenames and document IDs are request-owned pointers, not repeated model
// predictions. Bind them to this exact source before the normal strict parser.
export function parseCompactSourceAudit(
  raw: string,
  document: CaseDoc,
  pages: ReviewSourcePage[],
) {
  const payload = object(JSON.parse(raw));
  const expected = [
    "sourceVerdict",
    "fieldChecks",
    "lineItemChecks",
    "references",
    "newReferences",
    "fieldChanges",
    "removalEvidence",
    "structureChange",
    "pageQuality",
    "reviewIssues",
    "reason",
  ];
  if (
    Object.keys(payload).some((key) => !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(payload, key))
  )
    throw new Error(
      "Source response does not match its compact task contract.",
    );
  const assertOwnPointers = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(assertOwnPointers);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (
        ["docId", "documentId", "sourceDocId", "sourceFileName"].includes(key)
      )
        throw new Error(
          "Own-source task must not supply external source pointers.",
        );
      assertOwnPointers(entry);
    }
  };
  assertOwnPointers(payload);
  // The request owns these exact page pointers, just like document/file
  // pointers in packet review. No local/original page-number prediction or
  // number parsing is necessary; unknown pointers always fail.
  const pagePointers = new Map(
    ownDocumentPages(document, pages).map((page, index) => [
      `p${index + 1}`,
      page.pageNumber,
    ]),
  );
  const bindPagePointers = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(bindPagePointers);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (key !== "pageNumber") return [key, bindPagePointers(entry)];
        if (typeof entry !== "string" || !pagePointers.has(entry))
          throw new Error(
            `Unknown own-page pointer ${JSON.stringify(entry)}. Use ${[...pagePointers.keys()].join(" or ")}.`,
          );
        return [key, pagePointers.get(entry)];
      }),
    );
  };
  for (const key of [
    "references",
    "newReferences",
    "fieldChanges",
    "removalEvidence",
    "structureChange",
    "pageQuality",
    "reviewIssues",
  ])
    payload[key] = bindPagePointers(payload[key]);
  const checklist = buildReviewSourceSupportChecklist([document])[document.id];
  const fields: Record<string, unknown> = {};
  const referenceKeys = new Set<string>(
    REFERENCE_FIELD_DEFINITIONS.map(({ key }) => key),
  );
  for (const [field, rawReference] of Object.entries(
    object(payload.references),
  )) {
    const reference = object(rawReference);
    if (
      !referenceKeys.has(field) ||
      Object.keys(reference).some(
        (key) =>
          ![
            "value",
            "sourceLabel",
            "valueKind",
            "pageNumber",
            "quote",
          ].includes(key),
      )
    )
      throw new Error(
        `Reference ${field} must be a known keyed value-and-proof entry, without a repeated field property.`,
      );
    fields[field] = {
      ...reference,
      sourceFileName: document.sourceFileName,
    };
  }
  for (const rawReference of array(payload.newReferences)) {
    const reference = object(rawReference);
    const field = reference.field;
    if (
      typeof field !== "string" ||
      !referenceKeys.has(field) ||
      Object.hasOwn(fields, field) ||
      String(document.fields[field as FieldKey] ?? "").trim()
    )
      throw new Error(
        `A newly discovered reference must be known and distinct from every original or discovered reference: ${String(field)}.`,
      );
    const { field: ignoredField, ...entry } = reference;
    void ignoredField;
    if (
      Object.keys(entry).some(
        (key) =>
          ![
            "value",
            "sourceLabel",
            "valueKind",
            "pageNumber",
            "quote",
          ].includes(key),
      )
    )
      throw new Error(
        `New reference ${field} has unexpected evidence properties.`,
      );
    fields[field] = { ...entry, sourceFileName: document.sourceFileName };
  }
  const bindEvidence = (value: unknown, finding: string) => {
    const proof = object(value);
    if (
      Object.keys(proof).some((key) => !["pageNumber", "quote"].includes(key))
    )
      throw new Error(
        `${finding} evidence must contain only pageNumber and quote.`,
      );
    if (typeof proof.quote !== "string" || !proof.quote.trim())
      throw new Error(
        `${finding}: its own-page evidence quote is missing or blank.`,
      );
    const permittedPages = ownDocumentPages(document, pages).map(
      (page) => page.pageNumber,
    );
    if (!permittedPages.includes(proof.pageNumber as number))
      throw new Error(
        `${finding}: cited page ${JSON.stringify(proof.pageNumber)} is not this document's own page. Use original source page ${permittedPages.join(" or ")}, not local page numbering.`,
      );
    return {
      pageNumber: proof.pageNumber as number,
      quote: proof.quote,
      sourceFileName: document.sourceFileName!,
    };
  };
  const fieldSupport = exactSupport(
    checklist.fieldSupport,
    payload.fieldChecks,
  );
  const itemSupport = exactSupport(
    checklist.lineItemPropertySupport,
    payload.lineItemChecks,
  );
  const changes: Record<string, string | null> = {};
  const omissions: Record<string, unknown>[] = [];
  const pairedChanges: {
    field: FieldKey;
    value: string;
    evidenceKind: "printed" | "visual_observation";
    evidence: ReturnType<typeof bindEvidence>;
  }[] = [];
  const nonReferences = new Set(
    FIELD_DEFINITIONS.filter(
      ({ semanticKind }) => semanticKind !== "reference",
    ).map(({ key }) => key),
  );
  for (const rawChange of array(payload.fieldChanges)) {
    const change = object(rawChange);
    const field = change.field as FieldKey;
    if (
      !nonReferences.has(field) ||
      Object.hasOwn(changes, field) ||
      Object.keys(change).some(
        (key) =>
          !["field", "value", "evidenceKind", "pageNumber", "quote"].includes(
            key,
          ),
      ) ||
      typeof change.value !== "string" ||
      !change.value.trim()
    )
      throw new Error(
        `Invalid or duplicate printed field change: ${String(change.field)}.`,
      );
    const value = change.value.trim();
    const evidenceKind = change.evidenceKind ?? "printed";
    if (evidenceKind !== "printed" && evidenceKind !== "visual_observation")
      throw new Error(`Field ${field} has an unknown evidence kind.`);
    const expectedKind =
      FIELD_DEFINITIONS.find((definition) => definition.key === field)
        ?.evidenceKind ?? "printed";
    if (evidenceKind !== expectedKind)
      throw new Error(
        `Field ${field} requires ${expectedKind} evidence; visual observations cannot supply printed identifiers, amounts or weights.`,
      );
    const evidence = bindEvidence(
      { pageNumber: change.pageNumber, quote: change.quote },
      `Field ${field}`,
    );
    if (evidenceKind === "printed" && !evidence.quote.includes(value))
      throw new Error(
        `Field ${field}: the proposed value must appear literally in its paired own-page quote; do not normalize or infer it.`,
      );
    if (fieldSupport[field] === "unsupported")
      throw new Error(
        `Field ${field} cannot be both unsupported and supplied as a printed correction.`,
      );
    pairedChanges.push({ field, value, evidenceKind, evidence });
    changes[field] = value;
    // One validated observation supplies both the mutation and the audit. The
    // model never predicts the same missing value in a second list.
    if (
      evidenceKind === "printed" &&
      !String(document.fields[field] ?? "").trim()
    )
      omissions.push({ field, value, evidence });
  }
  const unsupportedFields = Object.keys(fieldSupport).filter(
    (field) => fieldSupport[field] === "unsupported",
  );
  const unsupportedProperties = Object.keys(itemSupport).filter(
    (key) => itemSupport[key] === "unsupported",
  );
  const removalEvidence =
    payload.removalEvidence === null
      ? null
      : bindEvidence(payload.removalEvidence, "Unsupported-value removal");
  if (
    (unsupportedFields.length || unsupportedProperties.length) &&
    !removalEvidence
  )
    throw new Error(
      "Unsupported source votes require removalEvidence; the app derives removals from those votes.",
    );
  for (const field of unsupportedFields) changes[field] = null;
  const structure =
    payload.structureChange === null ? null : object(payload.structureChange);
  if (
    structure &&
    (Object.keys(structure).some(
      (key) => !["documentType", "lineItems", "evidence"].includes(key),
    ) ||
      (!Object.hasOwn(structure, "documentType") &&
        !Object.hasOwn(structure, "lineItems")))
  )
    throw new Error(
      "A structure change must change only documentType or lineItems, not repeat field findings.",
    );
  const structureEvidence = structure
    ? bindEvidence(structure.evidence, "Structure change")
    : null;
  if (structure?.lineItems !== undefined && !Array.isArray(structure.lineItems))
    throw new Error(
      "A table correction must supply a complete lineItems array.",
    );
  const correctedItems =
    structure?.lineItems ??
    (unsupportedProperties.length ? (document.lineItems ?? []) : undefined);
  const lineItems = Array.isArray(correctedItems)
    ? correctedItems.map((rawItem) => {
        const item = { ...object(rawItem) };
        for (const property of unsupportedProperties) {
          if (
            structure?.lineItems !== undefined &&
            String(item[property] ?? "").trim()
          )
            throw new Error(
              `Table correction contradicts the unsupported ${property} verdict.`,
            );
          delete item[property];
        }
        return item;
      })
    : undefined;
  const correction =
    Object.keys(changes).length || structure || lineItems !== undefined
      ? {
          ...(structure?.documentType !== undefined
            ? { documentType: structure.documentType }
            : {}),
          ...(lineItems !== undefined ? { lineItems } : {}),
          fields: Object.entries(changes).map(([field, value]) => ({
            field,
            value,
          })),
          evidence:
            structureEvidence ?? removalEvidence ?? pairedChanges[0]?.evidence,
          reason: payload.reason,
          docId: document.id,
        }
      : null;
  const canonical = {
    referenceReviews: [{ docId: document.id, fields }],
    sourceSupport: {
      [document.id]: {
        fieldSupport,
        lineItemPropertySupport: itemSupport,
      },
    },
    documentAudits: [
      {
        docId: document.id,
        sourceVerdict: payload.sourceVerdict,
        visibleOmittedFields: omissions,
        reason: payload.reason,
      },
    ],
    corrections: correction ? [correction] : [],
    pageQuality: array(payload.pageQuality).map((value) => ({
      ...object(value),
      documentId: document.id,
      sourceFileName: document.sourceFileName,
    })),
    reviewIssues: [],
    mismatchDecisions: [],
    termsChecklist: [],
    packetGroups: [],
    notes: [],
  };
  const result = parseValidatedSourceReview(
    JSON.stringify(canonical),
    document,
    pages,
  );
  const ownPages = ownDocumentPages(document, pages);
  if (ownPages.length === 1 && result.document.lineItems?.length) {
    // Every accepted row of this scoped source belongs to its one original
    // page. Task-local sourcePage=1 is not an original page prediction.
    result.document = {
      ...result.document,
      lineItems: result.document.lineItems.map((item) => ({
        ...item,
        sourcePage: ownPages[0].pageNumber,
      })),
    };
  } else if (
    result.document.lineItems?.some(
      (item) => !ownPages.some((page) => page.pageNumber === item.sourcePage),
    )
  ) {
    throw new Error(
      "Every reviewed row in a multi-page source must retain an explicit own original sourcePage.",
    );
  }
  for (const { field, value } of pairedChanges) {
    if (result.document.fields[field] !== value)
      throw new Error(
        `The paired ${field} correction was not preserved in the saved source fields.`,
      );
  }
  result.audit.fieldEvidence = pairedChanges;
  if (
    structure?.documentType !== undefined &&
    result.document.type !== structure.documentType
  )
    throw new Error(
      "The proposed document type was not preserved after source validation.",
    );
  const issues = array(payload.reviewIssues).map((value) => {
    const issue = object(value);
    return {
      ...issue,
      evidence: array(issue.evidence).map((entry) => ({
        ...object(entry),
        docId: document.id,
        sourceFileName: document.sourceFileName,
      })),
    };
  });
  return {
    ...result,
    reviewIssues: parseGroundedReviewIssues(
      issues,
      [result.document],
      pages,
      `source:${document.id}`,
    ),
  };
}

export function parseGroundedReviewIssues(
  raw: unknown,
  documents: CaseDoc[],
  pages: ReviewSourcePage[],
  prefix: string,
): Mismatch[] {
  const fields = new Set<string>(
    FIELD_DEFINITIONS.map((definition) => definition.key),
  );
  return array(raw).map((value, index) => {
    const issue = object(value);
    if (
      typeof issue.field !== "string" ||
      !fields.has(issue.field) ||
      typeof issue.reason !== "string" ||
      !issue.reason.trim()
    )
      throw new Error(
        "Review issue must identify a valid field and explain its source-grounded finding.",
      );
    const evidence = array(issue.evidence);
    if (!evidence.length)
      throw new Error("Review issue omitted its source evidence.");
    const values = evidence.map((rawEvidence) => {
      const entry = object(rawEvidence);
      const document = documents.find((doc) => doc.id === entry.docId);
      if (
        !document ||
        typeof entry.value !== "string" ||
        !entry.value.trim() ||
        typeof entry.quote !== "string" ||
        !entry.quote.includes(entry.value) ||
        entry.sourceFileName !== document.sourceFileName ||
        !ownDocumentPages(document, pages).some(
          (page) => page.pageNumber === entry.pageNumber,
        )
      )
        throw new Error(
          "Review issue is not bound to a printed value on its cited document's own page.",
        );
      return {
        docId: document.id,
        value: entry.value,
        sourceFileName: document.sourceFileName,
        pageNumber: entry.pageNumber as number,
      };
    });
    if (
      new Set(values.map((entry) => entry.docId)).size > 1 &&
      new Set(values.map((entry) => entry.value.trim())).size === 1
    )
      throw new Error(
        "A cross-document issue cannot cite literally identical values as a difference.",
      );
    return {
      id: `evidence-review-${prefix}-${index + 1}`,
      field: issue.field as FieldKey,
      values,
      analysis: issue.reason,
      fixPlan:
        "Review the cited source evidence, replace any incorrect document, and analyze again.",
    };
  });
}

export function sourceAuditContext(
  document: CaseDoc,
  pages: ReviewSourcePage[],
  recheckReason?: string,
) {
  const checklist = buildReviewSourceSupportChecklist([document])[document.id];
  return {
    contractVersion: STAGED_REVIEW_CONTRACT_VERSION,
    document: {
      documentType: document.type,
      title: document.title,
      fields: document.fields,
      lineItems: document.lineItems ?? [],
      visibleText: document.md,
      qualityIssues: document.qualityIssues ?? [],
    },
    sourcePageNumbers: pages.map((page) => page.pageNumber),
    sourcePagePointers: pages.map((page, index) => ({
      pointer: `p${index + 1}`,
      originalPageNumber: page.pageNumber,
    })),
    fieldChecksInOrder: checklist.fieldSupport,
    lineItemChecksInOrder: checklist.lineItemPropertySupport,
    referencesToReview: REFERENCE_FIELD_DEFINITIONS.filter(({ key }) =>
      String(document.fields[key] ?? "").trim(),
    ).map(({ key }) => key),
    fieldMeanings: FIELD_DEFINITIONS.map(({ key, label, evidenceKind }) => ({
      field: key,
      meaning: label,
      evidenceKind: evidenceKind ?? "printed",
    })),
    recheckReason: recheckReason ?? null,
  };
}
