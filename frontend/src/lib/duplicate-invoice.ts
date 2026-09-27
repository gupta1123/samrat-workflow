import type { Mismatch } from "@/types/pipeline";
import { getPrimaryInvoiceDocuments } from "@/lib/invoice-approval";

export const DUPLICATE_INVOICE_FIELD = "duplicateInvoiceNumber";

export type DuplicateInvoiceDocument = {
  id: string;
  documentType: string;
  invoiceNumber: unknown;
  sourceFileName?: string | null;
  title?: string | null;
};

export type CollapsedDuplicateDocument = {
  id: string;
  documentType: string;
  invoiceNumber: unknown;
  collapsedDuplicateSources?: string[] | null;
};

/**
 * Collapse-trace check: extraction merged duplicate invoice copies into one
 * document to avoid double-counted totals. The merge is kept, but the
 * duplicate must be shown as a warning instead of disappearing silently.
 */
export function buildCollapsedDuplicateInvoiceIssues(params: {
  documents: CollapsedDuplicateDocument[];
}): Mismatch[] {
  const documents = Array.isArray(params.documents) ? params.documents : [];
  const issues: Mismatch[] = [];
  for (const document of documents) {
    const sources = [...new Set(
      (Array.isArray(document.collapsedDuplicateSources)
        ? document.collapsedDuplicateSources
        : []
      )
        .map((name) => String(name ?? "").trim())
        .filter(Boolean),
    )];
    if (sources.length < 2) continue;
    if (
      document.documentType !== "Invoice" &&
      document.documentType !== "Tax Invoice"
    ) {
      continue;
    }
    const printed =
      present(document.invoiceNumber) &&
      normalizeInvoiceNumber(document.invoiceNumber);
    const subject = printed
      ? `Invoice ${String(document.invoiceNumber).trim()}`
      : "An invoice";
    const key = printed || document.id;
    issues.push({
      id: `duplicate-invoice-collapsed:${key}`,
      field: DUPLICATE_INVOICE_FIELD,
      values: [
        {
          docId: "packet",
          value: `${subject} was uploaded ${sources.length} times and the copies were merged: ${sources.join("; ")}`,
        },
      ],
      analysis: `${subject} appears in ${sources.length} uploaded files (${sources.join("; ")}). The copies were merged so totals are counted once, but booking every upload would pay the vendor more than once.`,
      fixPlan:
        "Delete the duplicate file directly from this warning and the case will be re-analyzed automatically, or accept this issue to confirm only one booking will be made.",
    });
  }
  return issues;
}

export type DuplicateInvoiceSiblingCase = {
  id: string;
  displayName: string;
  status: string;
  invoiceNumber: unknown;
};

function present(value: unknown): boolean {
  return (
    (typeof value === "string" || typeof value === "number") &&
    String(value).trim() !== ""
  );
}

export function normalizeInvoiceNumber(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

function docLabel(document: DuplicateInvoiceDocument): string {
  const title =
    typeof document.title === "string" && document.title.trim()
      ? document.title.trim()
      : document.documentType;
  const file =
    typeof document.sourceFileName === "string" &&
    document.sourceFileName.trim()
      ? ` (${document.sourceFileName.trim()})`
      : "";
  return `${title}${file}`;
}

/**
 * Within-case check: the same buyer-facing vendor invoice number on two or
 * more documents from different source files. Same-file original/duplicate
 * copies are already collapsed by copy handling, so only distinct uploads
 * raise this issue.
 */
export function buildDuplicateInvoiceIssues(params: {
  documents: DuplicateInvoiceDocument[];
  verificationGroups?: unknown;
}): Mismatch[] {
  const documents = Array.isArray(params.documents) ? params.documents : [];
  const primaries = getPrimaryInvoiceDocuments(documents, params.verificationGroups);
  const byNumber = new Map<string, DuplicateInvoiceDocument[]>();
  for (const document of primaries) {
    if (!present(document.invoiceNumber)) continue;
    const normalized = normalizeInvoiceNumber(document.invoiceNumber);
    if (!normalized) continue;
    byNumber.set(normalized, [...(byNumber.get(normalized) ?? []), document]);
  }

  const issues: Mismatch[] = [];
  for (const [normalized, group] of byNumber) {
    if (group.length < 2) continue;
    const files = new Set(
      group.map((document) =>
        typeof document.sourceFileName === "string"
          ? document.sourceFileName.trim().toLowerCase()
          : "",
      ),
    );
    // Same-file copies (original/duplicate/triplicate pages of one scan) are
    // collapsed elsewhere; distinct uploads of one invoice are the risk.
    if (files.size < 2) continue;
    const printed = String(group[0].invoiceNumber).trim();
    const where = group.map(docLabel).join("; ");
    issues.push({
      id: `duplicate-invoice-number:${normalized}`,
      field: DUPLICATE_INVOICE_FIELD,
      values: [
        {
          docId: "packet",
          value: `Invoice ${printed} appears in ${group.length} documents: ${where}`,
        },
      ],
      analysis: `The same vendor invoice number (${printed}) was uploaded ${group.length} times in this case (${where}). Booking every copy would pay the vendor more than once.`,
      fixPlan:
        "Delete the duplicate file directly from this warning and the case will be re-analyzed automatically, or accept this issue to confirm only one booking will be made.",
    });
  }
  return issues;
}

/**
 * Cross-case check: this invoice number is already used by another live case
 * of the same owner (processing, completed, or accepted). Booking it again
 * here would duplicate the payable.
 */
export function buildCrossCaseDuplicateInvoiceIssues(params: {
  invoiceNumber: unknown;
  currentCaseId: string;
  siblings: DuplicateInvoiceSiblingCase[];
}): Mismatch[] {
  if (!present(params.invoiceNumber)) return [];
  const wanted = normalizeInvoiceNumber(params.invoiceNumber);
  if (!wanted) return [];
  const printed = String(params.invoiceNumber).trim();
  const matches = (Array.isArray(params.siblings) ? params.siblings : []).filter(
    (sibling) =>
      sibling &&
      sibling.id !== params.currentCaseId &&
      normalizeInvoiceNumber(sibling.invoiceNumber) === wanted,
  );
  if (!matches.length) return [];
  const where = matches
    .map(
      (sibling) =>
        `"${sibling.displayName || sibling.id}" (${sibling.status})`,
    )
    .join("; ");
  return [
    {
      id: `duplicate-invoice-across-cases:${wanted}`,
      field: DUPLICATE_INVOICE_FIELD,
      values: [
        {
          docId: "packet",
          value: `Invoice ${printed} is already used in ${matches.length === 1 ? "another case" : "other cases"}: ${where}`,
        },
      ],
      analysis: `Invoice ${printed} is already booked or in review in ${where}. Approving this case as well would record the same vendor invoice twice.`,
      fixPlan:
        "Open the listed case and confirm whether this invoice was already booked. " +
        "If it was, recycle this duplicate case. If it is a different purchase that happens to share a number, accept this issue to proceed.",
    },
  ];
}
