import { FIELD_DEFINITIONS } from "../document-schema";
import type { CaseDoc, FieldKey } from "../../types/pipeline";

// Domain schema, not a text classifier. The AI decides the meaning of a source
// label; this boundary checks that its proof belongs to the actual saved value.
export const REFERENCE_FIELD_DEFINITIONS = FIELD_DEFINITIONS.filter(
  (definition) => definition.semanticKind === "reference",
);
export const COUNTERPARTY_SOURCE_FIELDS = FIELD_DEFINITIONS.filter(
  (definition) => definition.counterpartySource,
).map((definition) => definition.key);

export type ReferenceGrounding = {
  field: FieldKey;
  value: string;
  sourceLabel: string;
  valueKind: "reference";
  sourceFileName: string;
  pageNumber: number;
  quote: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Printed references wrap across lines and Pad spacing ("NL 01 AD 8743",
// a 64-character IRN split over two lines). The proof must still contain the
// exact label and value with nothing added or removed; only whitespace runs
// and letter case are ignored when locating them inside the quote.
function squash(value: string): string {
  return value.toUpperCase().replace(/\s+/g, "");
}

export function assertReferenceGrounding(params: {
  document: CaseDoc;
  evidence: unknown;
  sourcePages: Array<{ sourceFileName: string; pageNumber: number }>;
}): ReferenceGrounding[] {
  const required = REFERENCE_FIELD_DEFINITIONS.filter((definition) =>
    String(params.document.fields[definition.key] ?? "").trim(),
  );
  if (!Array.isArray(params.evidence)) {
    throw new Error(`Missing referenceEvidence for ${params.document.id}.`);
  }
  const proofs = new Map<FieldKey, ReferenceGrounding>();
  for (const entry of params.evidence) {
    const proof = record(entry);
    const definition = required.find((item) => item.key === proof?.field);
    const value = String(proof?.value ?? "").trim();
    const sourceLabel = String(proof?.sourceLabel ?? "").trim();
    const quote = String(proof?.quote ?? "").trim();
    const sourceFileName = String(proof?.sourceFileName ?? "").trim();
    const pageNumber = proof?.pageNumber;
    if (
      !definition ||
      proofs.has(definition.key) ||
      proof?.valueKind !== "reference" ||
      !value ||
      value !== String(params.document.fields[definition.key] ?? "").trim() ||
      !sourceLabel ||
      !squash(quote).includes(squash(sourceLabel)) ||
      !squash(quote).includes(squash(value)) ||
      sourceFileName !== params.document.sourceFileName ||
      typeof pageNumber !== "number" ||
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      (params.document.sourcePageNumbers &&
        !params.document.sourcePageNumbers.includes(pageNumber)) ||
      (params.sourcePages.length > 0 &&
        !params.sourcePages.some(
          (page) =>
            page.sourceFileName === sourceFileName &&
            page.pageNumber === pageNumber,
        ))
    ) {
      throw new Error(
        `Invalid semantic reference evidence on ${params.document.id}: ${String(proof?.field ?? "unknown")}. Re-read its label and value together; document types, headings, dates and unrelated IDs are not interchangeable references.`,
      );
    }
    proofs.set(definition.key, {
      field: definition.key,
      value,
      sourceLabel,
      valueKind: "reference",
      sourceFileName,
      pageNumber,
      quote,
    });
  }
  if (proofs.size !== required.length) {
    throw new Error(
      `Missing semantic reference evidence on ${params.document.id}: ${required
        .filter((item) => !proofs.has(item.key))
        .map((item) => item.key)
        .join(", ")}.`,
    );
  }
  return [...proofs.values()];
}

export type CounterpartySource = { docId: string; field: FieldKey };

export function assertCounterpartySource(params: {
  source: unknown;
  counterpartyName: string;
  documents: CaseDoc[];
  primaryDocumentIds?: string[];
  contextDocumentIds?: string[];
}): CounterpartySource | null {
  if (params.source === null && !params.counterpartyName) return null;
  const source = record(params.source);
  const docId = String(source?.docId ?? "").trim();
  const document = params.documents.find((doc) => doc.id === docId);
  const field = COUNTERPARTY_SOURCE_FIELDS.find((key) => key === source?.field);
  const primaryIds = params.primaryDocumentIds ?? [];
  const contextIds = params.contextDocumentIds ?? [];
  if (
    !document ||
    !field ||
    !params.counterpartyName ||
    String(document.fields[field] ?? "").trim() !== params.counterpartyName ||
    (contextIds.includes(docId) && !primaryIds.includes(docId))
  ) {
    throw new Error(
      "The case counterparty is not bound to a reviewed external-party field. For purchase verification, cite the supplier, not the billed buyer, ship-to party, or upstream context invoice.",
    );
  }
  // A purchase's supplier is a canonical role, not the most frequent name. A
  // carrier/holder may name its own non-commercial case but not a purchase.
  const hasPurchaseParty = params.documents.some(
    (doc) =>
      !contextIds.includes(doc.id) &&
      (doc.type === "Invoice" ||
        doc.type === "Tax Invoice" ||
        doc.type === "Purchase Order" ||
        doc.type === "Amended Purchase Order") &&
      String(doc.fields.vendorName ?? "").trim(),
  );
  if (hasPurchaseParty && field !== "vendorName") {
    throw new Error(
      "A purchase case title must cite its reviewed supplier role.",
    );
  }
  return { docId, field };
}
