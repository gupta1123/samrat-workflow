import { poNotOnInvoice } from "./candidate-ranking";
import { candidateEvidence } from "./evidence";
import type { LineResult, MatchInvoice } from "./types";

const REFERENCE_NAME: Record<string, string> = {
  "PO reference": "PO",
  "Invoice No.": "invoice no.",
  "E-Way Bill No.": "e-way bill",
  "Lorry Receipt No.": "lorry receipt",
  "Vehicle No.": "truck",
};

/**
 * One short line per receipt in use whose references disagree with the invoice
 * (or cannot confirm it). The full side-by-side lives in the receipts drawer;
 * this is only the exception a reviewer must see without opening anything.
 */
export function receiptProblems(invoice: MatchInvoice, line: LineResult) {
  const selected = line.candidates.filter(
    (candidate) => candidate.allocated > 0,
  );
  const service = line.kind === "service";
  const ignorePo = !service && poNotOnInvoice(invoice, line.candidates);
  const rows: string[] = [];
  for (const candidate of selected) {
    for (const row of candidateEvidence(invoice, candidate)) {
      if (ignorePo && row.label === "PO reference") continue;
      if (row.scanned === "Not recorded") continue;
      if (row.status === "Matched") continue;
      if (row.sap === "Not recorded in saved check") continue;
      const name = REFERENCE_NAME[row.label] ?? row.label.toLowerCase();
      const doc = `${candidate.kind} ${candidate.docNum}`;
      rows.push(
        row.status === "Different"
          ? `${doc}: different ${name} (${row.sap})`
          : row.status === "Partly matched"
            ? `${doc}: ${name} only partly matches (${row.sap})`
            : `${doc}: ${name} can't be confirmed (${row.sap})`,
      );
    }
  }
  const missing = selected
    .filter((candidate) => !candidate.references)
    .map((candidate) => `${candidate.kind} ${candidate.docNum}`);
  return {
    rows,
    /** Saved checks from before references were stored. */
    missingNote: missing.length
      ? `${missing.join(", ")}: reference values were not recorded in this saved check.`
      : null,
    ignoredPo: ignorePo && selected.length ? invoice.poReferences : null,
  };
}
