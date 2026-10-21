function label(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

const INDIAN_GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Compare labels without changing the extracted invoice or SAP currency.
 * "Rs." is shared by several rupee currencies, so accept it as INR only
 * when the invoice itself supplies Indian GST identification.
 */
export function invoiceCurrencyMatchesSap(
  invoiceCurrency: unknown,
  sapCurrency: unknown,
  invoiceGstins: readonly unknown[] = [],
): boolean {
  const invoice = label(invoiceCurrency);
  const sap = label(sapCurrency);
  // Preserve the existing policy for an invoice with no printed currency.
  if (!invoice) return true;
  if (!sap) return false;
  if (invoice === sap) return true;
  if (invoice === "₹") return sap === "INR";
  return (
    sap === "INR" &&
    /^(?:RS\.?|RUPEES?)$/.test(invoice) &&
    invoiceGstins.some((gstin) => INDIAN_GSTIN.test(label(gstin)))
  );
}
