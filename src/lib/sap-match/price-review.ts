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
};

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
    valueDifference:
      Number.isFinite(line.allocatedQty) && line.allocatedQty > 0
        ? difference * line.allocatedQty
        : null,
    partialAllocation:
      line.invoiceQty != null &&
      Math.abs(line.allocatedQty - line.invoiceQty) > 0.0005,
  };
}
