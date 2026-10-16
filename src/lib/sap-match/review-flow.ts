import type { MatchResult } from "./types";

export type ReviewFlow =
  | "material_grpo"
  | "non_stock_po"
  | "service_po"
  | "mixed"
  | "already_recorded";

/** Stored on packet_cases.review_flow. Decided from SAP's own item flags in the
 * match result, never from names, amounts or the absence of documents. Keep in
 * step with the backfill in 20261016120000_case_review_flow.sql.
 */
export function reviewFlowOf(
  result: Pick<MatchResult, "lines" | "existingInvoice">,
): ReviewFlow | null {
  if (result.existingInvoice) return "already_recorded";
  const flows = new Set<ReviewFlow>();
  for (const line of result.lines) {
    if (line.kind === "material") flows.add("material_grpo");
    else if (line.kind === "service") flows.add("service_po");
    else if (line.kind === "non-stock") flows.add("non_stock_po");
    else if (line.nonStockPoCandidates?.length) flows.add("non_stock_po");
  }
  if (flows.size === 0) return null;
  return flows.size === 1 ? [...flows][0] : "mixed";
}
