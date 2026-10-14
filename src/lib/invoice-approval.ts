import type { SavedCaseDetail } from "@/lib/case-persistence";
import type { Mismatch } from "@/types/pipeline";

export const INVOICE_NUMBER_REQUIRED_FIELD = "invoiceNumberRequired";
export type InvoiceApprovalDocument = {
  id: string;
  documentType: string;
  invoiceNumber: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function present(value: unknown) {
  return (
    (typeof value === "string" || typeof value === "number") &&
    String(value).trim() !== ""
  );
}

export function getPrimaryInvoiceDocuments(
  documents: InvoiceApprovalDocument[],
  verificationGroups: unknown,
  invoiceAssemblies?: unknown,
  includeDuplicateCopies = false,
) {
  const contextIds = new Set<string>();
  const primaryIds = new Set<string>();
  const continuationIds = new Set<string>();
  for (const raw of Array.isArray(invoiceAssemblies) ? invoiceAssemblies : []) {
    const assembly = record(raw);
    const sources = Array.isArray(assembly.fieldSources)
      ? assembly.fieldSources.map(record)
      : [];
    const identity = sources.find((source) => source.field === "invoiceNumber");
    const identityDoc = documents.find((doc) => doc.id === identity?.docId);
    if (
      !identityDoc ||
      !present(identityDoc.invoiceNumber) ||
      String(identityDoc.invoiceNumber).trim() !== assembly.invoiceNumber
    )
      continue;
    for (const rawMember of Array.isArray(assembly.documents)
      ? assembly.documents
      : []) {
      const member = record(rawMember);
      if (
        member.docId !== identityDoc.id &&
        typeof member.docId === "string" &&
        (includeDuplicateCopies
          ? ["header", "billing"]
          : ["header", "billing", "duplicate"]
        ).includes(String(member.role))
      )
        continuationIds.add(member.docId);
    }
  }
  if (Array.isArray(verificationGroups)) {
    for (const group of verificationGroups) {
      const roles = record(record(group).roleSelection);
      if (roles.strategy !== "seller_chain") continue;
      for (const id of Array.isArray(roles.contextDocumentIds)
        ? roles.contextDocumentIds
        : []) {
        if (typeof id === "string") contextIds.add(id);
      }
      for (const id of Array.isArray(roles.primaryDocumentIds)
        ? roles.primaryDocumentIds
        : []) {
        if (typeof id === "string") primaryIds.add(id);
      }
    }
  }
  return documents.filter(
    (document) =>
      (document.documentType === "Invoice" ||
        document.documentType === "Tax Invoice") &&
      (primaryIds.has(document.id) || !contextIds.has(document.id)) &&
      !continuationIds.has(document.id),
  );
}

export function getInvoiceNumberApprovalBlockReason(params: {
  invoiceNumber: unknown;
  documents: InvoiceApprovalDocument[];
  verificationGroups?: unknown;
  invoiceAssemblies?: unknown;
}): string | null {
  const invoices = getPrimaryInvoiceDocuments(
    params.documents,
    params.verificationGroups,
    params.invoiceAssemblies,
  );
  if (!invoices.length) {
    return "Approval is blocked because a buyer-facing invoice is required. Upload the invoice and analyze again.";
  }
  if (invoices.some((invoice) => !present(invoice.invoiceNumber))) {
    return "Approval is blocked because the invoice number is missing from a buyer-facing invoice. Replace it with a numbered invoice and analyze again.";
  }
  if (!present(params.invoiceNumber)) {
    return "Approval is blocked because the primary invoice number was not verified. Analyze the case again before approval.";
  }
  return null;
}

export function getSavedCaseInvoiceApprovalBlockReason(
  detail: SavedCaseDetail,
) {
  return getInvoiceNumberApprovalBlockReason({
    invoiceNumber: detail.case.invoiceNumber,
    documents: detail.documents.map((document) => ({
      id: document.clientDocumentId || document.id,
      documentType: document.documentType,
      invoiceNumber: document.extractedFields.invoiceNumber,
    })),
    verificationGroups: detail.case.processingMeta?.verificationGroups,
    invoiceAssemblies: detail.case.processingMeta?.invoiceAssemblies,
  });
}

export function buildInvoiceNumberRequiredIssues(params: {
  invoiceNumber: unknown;
  documents: InvoiceApprovalDocument[];
  verificationGroups?: unknown;
  invoiceAssemblies?: unknown;
}): Mismatch[] {
  const reason = getInvoiceNumberApprovalBlockReason(params);
  if (!reason) return [];
  const missingInvoices = getPrimaryInvoiceDocuments(
    params.documents,
    params.verificationGroups,
    params.invoiceAssemblies,
  ).filter((invoice) => !present(invoice.invoiceNumber));
  return (missingInvoices.length ? missingInvoices : [{ id: "packet" }]).map(
    (invoice) => ({
      id: `required-invoice-number:${invoice.id}`,
      field: INVOICE_NUMBER_REQUIRED_FIELD,
      values: [{ docId: invoice.id, value: "Invoice number is missing" }],
      analysis: reason,
      fixPlan:
        "Upload a corrected packet with a buyer-facing invoice that shows its invoice number, then analyze again. This requirement cannot be waived by settling an issue.",
    }),
  );
}

// Mandatory validation owns its exact field/document subjects. An AI finding
// about that same absent field is the same requirement, not another mismatch.
// Preserve actual numbered-invoice conflicts and all other reading findings.
export function consolidateInvoiceNumberIssues(
  issues: Mismatch[],
  requiredIssues: Mismatch[],
): Mismatch[] {
  const ownedDocumentIds = new Set(
    requiredIssues.flatMap((issue) => issue.values.map(({ docId }) => docId)),
  );
  return [
    ...issues.filter(
      (issue) =>
        issue.field !== INVOICE_NUMBER_REQUIRED_FIELD &&
        !(
          issue.field === "invoiceNumber" &&
          issue.values.length > 0 &&
          issue.values.every(({ docId }) => ownedDocumentIds.has(docId))
        ),
    ),
    ...requiredIssues,
  ];
}
