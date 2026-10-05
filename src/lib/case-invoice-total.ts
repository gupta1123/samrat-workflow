type InvoiceTotalDocument = {
  id: string;
  clientDocumentId?: string | null;
  documentType: string;
  extractedFields: Readonly<Record<string, unknown>>;
};

/** The case amount represents the scanned invoice, never an order or transport document. */
export function getCaseInvoiceTotal(
  documents: readonly InvoiceTotalDocument[],
  primaryDocumentIds: ReadonlySet<string> = new Set(),
): number | null {
  const invoices = documents.filter((document) =>
    /^(?:tax\s+)?invoice$/i.test(document.documentType.trim()),
  );
  const primaryInvoices = invoices.filter(
    (document) =>
      primaryDocumentIds.has(document.id) ||
      Boolean(
        document.clientDocumentId &&
        primaryDocumentIds.has(document.clientDocumentId),
      ),
  );

  for (const invoice of primaryInvoices.length ? primaryInvoices : invoices) {
    const match = String(invoice.extractedFields.totalAmount ?? "")
      .replace(/,/g, "")
      .match(/-?\d+(?:\.\d+)?/);
    if (!match) continue;
    const total = Number(match[0]);
    if (Number.isFinite(total)) return total;
  }
  return null;
}
