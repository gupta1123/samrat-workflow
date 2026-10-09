import type { CandidateView, MatchInvoice } from "./types";
import { candidateEvidence } from "./evidence";

export type ReferenceSignal = {
  label: string;
  status: "same" | "different";
  sap: string;
  note?: string;
};

export type RankedCandidate = {
  candidate: CandidateView;
  signals: ReferenceSignal[];
  same: number;
  different: number;
  /** Invoice number stores recorded on the GRPO when it names a different invoice. */
  otherInvoice: string | null;
  /** Engine warnings not already shown as a reference signal (dates, balances…). */
  otherWarnings: string[];
};

const SHORT_LABEL: Record<string, string> = {
  "PO reference": "PO",
  "Invoice No.": "Invoice",
  "E-Way Bill No.": "E-way bill",
  "Lorry Receipt No.": "Lorry receipt",
  "Vehicle No.": "Vehicle",
};

/** Engine warnings about references are replaced by the signals themselves. */
const REFERENCE_WARNING =
  /\bPO\b|invoice (number|reference)|another invoice|e-?way bill|lorry receipt|truck|vehicle/i;

/**
 * True when the invoice prints no reference that matches any candidate's PO,
 * e.g. Tata prints its own sales order number instead of the SAP PO number.
 * A PO "difference" on every GRPO then carries no information.
 */
export function poNotOnInvoice(
  invoice: MatchInvoice,
  candidates: CandidateView[],
) {
  if (!candidates.some((candidate) => candidate.references)) return false;
  return !candidates.some((candidate) => {
    const row = candidateEvidence(invoice, candidate).find(
      (entry) => entry.label === "PO reference",
    );
    return row?.status === "Matched" || row?.status === "Partly matched";
  });
}

export function rankCandidate(
  invoice: MatchInvoice,
  candidate: CandidateView,
  ignorePo: boolean,
): RankedCandidate {
  const signals: ReferenceSignal[] = candidateEvidence(invoice, candidate)
    .filter(
      (row) =>
        !(ignorePo && row.label === "PO reference") &&
        (row.status === "Matched" ||
          row.status === "Partly matched" ||
          row.status === "Different"),
    )
    .map((row) => ({
      label: SHORT_LABEL[row.label] ?? row.label,
      status: row.status === "Different" ? "different" : "same",
      sap: row.sap,
      note: row.note,
    }));
  const invoiceRow = signals.find((signal) => signal.label === "Invoice");
  return {
    candidate,
    signals,
    same: signals.filter((signal) => signal.status === "same").length,
    different: signals.filter((signal) => signal.status === "different")
      .length,
    otherInvoice:
      invoiceRow?.status === "different" ? invoiceRow.sap : null,
    otherWarnings: candidate.bad.filter(
      (warning) => !REFERENCE_WARNING.test(warning),
    ),
  };
}

/** Most matching references first, then fewest conflicts, then engine score. */
export function rankCandidates(
  invoice: MatchInvoice,
  candidates: CandidateView[],
  ignorePo: boolean,
) {
  return candidates
    .map((candidate) => rankCandidate(invoice, candidate, ignorePo))
    .sort(
      (a, b) =>
        b.same - a.same ||
        a.different - b.different ||
        b.candidate.score - a.candidate.score,
    );
}
