export type SapWithholdingTaxRow = {
  WTAmount?: number | string | null;
};

export type SapDraftTotalReconciliation = {
  matches: boolean;
  netPayable: number;
  withholdingTax: number;
  invoiceTotal: number;
  matchedUsingWithholding: boolean;
};

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * SAP Business One can return DocTotal after vendor withholding tax is deducted.
 * The vendor invoice total is the gross amount, so accept either DocTotal itself
 * or DocTotal plus SAP's explicit withholding rows. Never infer a deduction.
 */
export function reconcileSapDraftTotal(input: {
  docTotal: unknown;
  withholdingTaxes?: SapWithholdingTaxRow[] | null;
  expectedInvoiceTotal: number;
  tolerance?: number;
}): SapDraftTotalReconciliation | null {
  const netPayable = finiteNumber(input.docTotal);
  if (netPayable === null) return null;

  const withholdingTax = (input.withholdingTaxes ?? []).reduce((sum, row) => {
    const amount = finiteNumber(row.WTAmount);
    return amount !== null && amount > 0 ? sum + amount : sum;
  }, 0);
  const tolerance =
    input.tolerance ?? Math.max(1, input.expectedInvoiceTotal * 0.00001);
  const directMatch =
    Math.abs(netPayable - input.expectedInvoiceTotal) <= tolerance;
  const grossTotal = netPayable + withholdingTax;
  const withholdingMatch =
    withholdingTax > 0 &&
    Math.abs(grossTotal - input.expectedInvoiceTotal) <= tolerance;

  return {
    matches: directMatch || withholdingMatch,
    netPayable,
    withholdingTax,
    invoiceTotal: withholdingMatch ? grossTotal : netPayable,
    matchedUsingWithholding: withholdingMatch,
  };
}
