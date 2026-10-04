import type { LineResult } from "./types";

/** Preview edits without silently clamping them or changing the matching rules. */
export function receiptSelection(
  line: LineResult,
  edits: Record<string, string>,
) {
  const allocations: Record<string, number> = {};
  const errors: Record<string, string> = {};
  let dirty = false;
  for (const candidate of line.candidates) {
    if (candidate.rejected) continue;
    const raw = edits[candidate.key];
    const value =
      raw === undefined
        ? candidate.allocated
        : raw.trim() === ""
          ? 0
          : Number(raw);
    if (raw !== undefined && value !== candidate.allocated) dirty = true;
    if (!Number.isFinite(value) || value < 0) {
      errors[candidate.key] = "Enter a valid quantity of zero or more.";
    } else if (line.kind !== "service" && value > candidate.open + 0.000001) {
      errors[candidate.key] =
        "Quantity exceeds what is available on this receipt.";
    }
    if (Number.isFinite(value) && value > 0) allocations[candidate.key] = value;
  }
  const total =
    Math.round(
      Object.values(allocations).reduce((sum, value) => sum + value, 0) * 1000,
    ) / 1000;
  const billed = line.kind === "service" ? line.invoiceAmount : line.invoiceQty;
  const remaining =
    billed == null ? null : Math.round((billed - total) * 1000) / 1000;
  return { allocations, errors, dirty, total, billed, remaining };
}
