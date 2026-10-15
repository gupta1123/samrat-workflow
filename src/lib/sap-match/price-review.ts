import type { LineResult, MatchInvoice } from "./types";

export type PriceReviewDetails = {
  difference: number;
  direction: "lower" | "higher";
  percent: number;
  tolerancePct: number;
  comparisonSource: string;
  unit: string | null;
  valueDifference: number | null;
  partialAllocation: boolean;
  /** Invoice freight that the lower rate appears to have been moved into. */
  freightExplains: number | null;
};

/** Within 1% (and at least ₹1) of the invoice freight. */
function sameAmount(a: number, b: number) {
  return Math.abs(a - b) <= Math.max(1, b * 0.01);
}

/** Display the same rate and allocated quantity the engine actually compares. */
export function priceReviewDetails(
  invoice: MatchInvoice,
  line: LineResult,
  tolerancePct: number | undefined,
): PriceReviewDetails | undefined {
  const rate = line.invoiceRate;
  const base = line.po?.rate;
  if (
    rate == null ||
    base == null ||
    base <= 0 ||
    !Number.isFinite(rate) ||
    !Number.isFinite(base) ||
    tolerancePct == null ||
    !Number.isFinite(tolerancePct) ||
    tolerancePct < 0
  )
    return;
  const difference = Math.abs(rate - base);
  if (difference === 0) return;
  // PO-based allocations are amounts, not quantities. Never multiply a rate
  // difference by the money allocated to a service/non-stock PO line.
  const allocatedUnits =
    line.kind === "service" || line.kind === "non-stock"
      ? line.invoiceQty
      : line.allocatedQty;
  const valueDifference =
    allocatedUnits != null &&
    Number.isFinite(allocatedUnits) &&
    allocatedUnits > 0
      ? difference * allocatedUnits
      : null;
  const invoiceDifference =
    line.invoiceQty != null && line.invoiceQty > 0
      ? difference * line.invoiceQty
      : valueDifference;
  const freight = invoice.freightAmount;
  return {
    difference,
    direction: rate < base ? "lower" : "higher",
    percent: (difference / base) * 100,
    tolerancePct,
    comparisonSource:
      line.po?.rateSource === "grpo"
        ? "SAP GRPO"
        : line.po?.rateSource === "po"
          ? "SAP PO"
          : "SAP comparison price",
    unit: invoice.lines[line.index]?.unit?.trim() || null,
    valueDifference,
    partialAllocation:
      line.invoiceQty != null &&
      allocatedUnits != null &&
      Math.abs(allocatedUnits - line.invoiceQty) > 0.0005,
    freightExplains:
      rate < base &&
      freight > 0 &&
      invoiceDifference != null &&
      sameAmount(invoiceDifference, freight)
        ? freight
        : null,
  };
}
