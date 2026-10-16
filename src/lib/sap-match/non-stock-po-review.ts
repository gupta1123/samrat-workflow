import type {
  CandidateView,
  LineResult,
  MatchInvoice,
  MatchResult,
} from "./types";

/** Buyer reference format used on Samrat invoices. This is deliberately NOT
 * the shared material/GRPO reference normalizer, nor a general suffix match.
 * Recognising a PO reference only narrows the review; it never selects a line.
 */
export function nonStockPoReferenceMatches(
  printed: readonly string[],
  sap: readonly (string | number)[],
): boolean {
  const refs = new Set(sap.map((value) => String(value).trim().toUpperCase()));
  return printed.some((value) => {
    const ref = value.trim().toUpperCase();
    if (!ref) return false;
    if (refs.has(ref)) return true;
    const buyerReference = /^SIPL\s*\/\s*(\d+)$/.exec(ref);
    return Boolean(buyerReference && refs.has(buyerReference[1]));
  });
}

/** These alternatives were already restricted to this supplier and verified
 * InventoryItem=tNO by the engine. Material lines can never enter this UI path.
 */
export function citedNonStockPoCandidates(
  invoice: Pick<MatchInvoice, "poReferences">,
  line: LineResult,
): CandidateView[] {
  const candidates =
    line.kind === "unmapped"
      ? (line.nonStockPoCandidates ?? [])
      : line.kind === "non-stock"
        ? line.candidates
        : [];
  return candidates.filter(
    (candidate) =>
      candidate.kind === "PO" &&
      candidate.documentType === "dDocument_Items" &&
      Boolean(candidate.itemCode) &&
      !candidate.rejected &&
      nonStockPoReferenceMatches(invoice.poReferences, [
        candidate.docNum,
        ...(candidate.references?.po ?? []),
      ]),
  );
}

export function needsNonStockPoConfirmation(
  invoice: Pick<MatchInvoice, "poReferences">,
  line: LineResult,
) {
  // A linked non-stock line is reviewed the same way until a PO line is confirmed.
  const unconfirmed =
    line.kind === "unmapped" ||
    (line.kind === "non-stock" &&
      !line.candidates.some((candidate) => candidate.allocated > 0));
  return unconfirmed && citedNonStockPoCandidates(invoice, line).length > 0;
}

export function isNonStockPoReview(
  invoice: Pick<MatchInvoice, "poReferences">,
  result: Pick<MatchResult, "lines">,
) {
  return (
    result.lines.length > 0 &&
    result.lines.every(
      (line) =>
        line.kind === "non-stock" || needsNonStockPoConfirmation(invoice, line),
    )
  );
}

/** A line that is matched to a supplier PO line (not to a goods receipt): a
 * non-stock or service item, or an unlinked line whose supplier has open
 * non-stock PO lines. Confirmed or not, these are reviewed in the PO-line table.
 */
export function isPoLineReviewLine(line: LineResult) {
  const pool =
    line.kind === "unmapped"
      ? (line.nonStockPoCandidates ?? [])
      : line.kind === "non-stock" || line.kind === "service"
        ? line.candidates
        : [];
  return pool.some((candidate) => candidate.kind === "PO");
}
