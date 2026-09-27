import type { CaseDoc, FieldKey } from "../../types/pipeline";
import {
  assertReferenceGrounding,
  REFERENCE_FIELD_DEFINITIONS,
} from "./semantic-grounding";

export const REFERENCE_FIELD_KEYS = new Set<FieldKey>(
  REFERENCE_FIELD_DEFINITIONS.map(({ key }) => key),
);
const VALUE_KINDS = new Set([
  "reference",
  "document_type",
  "date",
  "party",
  "other",
  "absent",
  "unreadable",
]);
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// One model-authored ledger entry owns the value AND its proof. Application
// code only validates and materializes these decisions; it never identifies a
// document value by its spelling, format, neighbouring digits, or frequency.
export function readReferenceLedger(params: {
  document: CaseDoc;
  fields: unknown;
  sourcePages: Array<{ sourceFileName: string; pageNumber: number }>;
}) {
  const ledger = object(params.fields);
  if (!ledger)
    throw new Error(`Missing reference ledger on ${params.document.id}.`);
  const required = REFERENCE_FIELD_DEFINITIONS.filter(({ key }) =>
    String(params.document.fields[key] ?? "").trim(),
  ).map(({ key }) => key);
  if (required.some((key) => !Object.hasOwn(ledger, key))) {
    throw new Error(
      `The reference ledger omitted original fields on ${params.document.id}: ${required.filter((key) => !Object.hasOwn(ledger, key)).join(", ")}.`,
    );
  }
  const finalFields: Partial<Record<FieldKey, string>> = {};
  const evidence: Array<Record<string, unknown>> = [];
  const changes: Array<{
    field: FieldKey;
    value: string | null;
    evidence: { sourceFileName: string; pageNumber: number; quote: string };
  }> = [];
  const originalSupport: Partial<
    Record<FieldKey, "supported" | "unsupported">
  > = {};
  let hasUnresolvedSource = false;
  for (const [rawField, rawEntry] of Object.entries(ledger)) {
    const field = REFERENCE_FIELD_DEFINITIONS.find(
      ({ key }) => key === rawField,
    )?.key;
    const entry = object(rawEntry);
    const pageNumber = entry?.pageNumber;
    const sourceFileName = entry?.sourceFileName;
    const value = entry?.value;
    if (
      !field ||
      !entry ||
      (value !== null && (typeof value !== "string" || !value.trim())) ||
      typeof entry.sourceLabel !== "string" ||
      typeof entry.quote !== "string" ||
      !VALUE_KINDS.has(String(entry.valueKind)) ||
      typeof sourceFileName !== "string" ||
      sourceFileName !== params.document.sourceFileName ||
      typeof pageNumber !== "number" ||
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      (params.document.sourcePageNumbers &&
        !params.document.sourcePageNumbers.includes(pageNumber)) ||
      (params.sourcePages.length &&
        !params.sourcePages.some(
          (page) =>
            page.sourceFileName === sourceFileName &&
            page.pageNumber === pageNumber,
        ))
    ) {
      throw new Error(
        `Invalid value-and-proof reference ledger entry on ${params.document.id}: ${rawField}.`,
      );
    }
    const finalValue = typeof value === "string" ? value.trim() : null;
    if (entry.valueKind === "unreadable") hasUnresolvedSource = true;
    const originalValue = String(params.document.fields[field] ?? "").trim();
    if (finalValue !== null) {
      finalFields[field] = finalValue;
      evidence.push({ ...entry, field, value: finalValue });
    }
    if (originalValue)
      originalSupport[field] =
        finalValue === null ? "unsupported" : "supported";
    if ((finalValue ?? "") !== originalValue)
      changes.push({
        field,
        value: finalValue,
        evidence: { sourceFileName, pageNumber, quote: entry.quote },
      });
  }
  const proofs = assertReferenceGrounding({
    document: { ...params.document, fields: finalFields },
    evidence,
    sourcePages: params.sourcePages,
  });
  return { finalFields, proofs, changes, originalSupport, hasUnresolvedSource };
}
