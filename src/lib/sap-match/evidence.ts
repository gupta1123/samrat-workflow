import type {
  CandidateView,
  LineResult,
  MatchCheck,
  MatchInvoice,
  MatchResult,
} from "./types";

export type EvidenceRow = {
  label: string;
  scanned: string;
  sap: string;
  status: "Matched" | "Different" | "Not checked" | "Partly matched";
  note?: string;
  source?: string;
};

const normalized = (value: string) =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, "");
const usable = (value: string) =>
  Boolean(normalized(value) && !/^0+$/.test(normalized(value)));

const placeholder = (value: string) =>
  Boolean(normalized(value) && /^0+$/.test(normalized(value)));

/** Stores often add a part suffix per truck: 2413387831-2 is still invoice 2413387831. */
function suffixOf(scanned: string, sap: string) {
  const match = sap
    .trim()
    .match(/^(.*?)\s*[-/]\s*(\d{1,2})$/);
  return match && normalized(match[1]) === normalized(scanned)
    ? match[2]
    : null;
}

function compare(
  label: string,
  scanned: string[],
  sap: string[],
  recorded: boolean,
  source?: string,
  allowPartSuffix = false,
): EvidenceRow {
  const left = scanned.filter(usable),
    right = sap.filter(usable);
  const suffixed: string[] = [];
  const matched = left.filter((value) =>
    right.some((other) => {
      if (normalized(value) === normalized(other)) return true;
      if (allowPartSuffix && suffixOf(value, other)) {
        suffixed.push(other);
        return true;
      }
      return false;
    }),
  );
  const additional = left.filter((value) => !matched.includes(value));
  return {
    label,
    scanned: scanned.join(", ") || "Not recorded",
    sap: recorded
      ? sap
          .map((value) => (placeholder(value) ? "Blank in SAP" : value))
          .join(", ") || "Not recorded"
      : "Not recorded in saved check",
    status:
      !recorded || !left.length || !right.length
        ? "Not checked"
        : !matched.length
          ? "Different"
          : additional.length
            ? "Partly matched"
            : "Matched",
    note:
      matched.length && additional.length
        ? `Matched: ${matched.join(", ")}. Additional packet reference: ${additional.join(", ")} (not matched to this document).`
        : suffixed.length
          ? `SAP records ${suffixed.join(", ")}: the same invoice with a part suffix.`
          : sap.some(placeholder)
            ? "Stores left this blank in SAP (saved as 0), so it cannot confirm this reference."
            : undefined,
    source,
  };
}

export function candidateEvidence(
  invoice: MatchInvoice,
  candidate: CandidateView,
): EvidenceRow[] {
  const refs = candidate.references;
  const rows = [
    compare(
      "PO reference",
      invoice.poReferences,
      refs?.po ?? (candidate.poRef ? [candidate.poRef] : []),
      Boolean(refs),
      invoice.referenceSources?.po
        .map((entry) => `${entry.value}: ${entry.source}`)
        .join("; "),
    ),
  ];
  if (candidate.kind === "PO") return rows;
  rows.push(
    compare(
      "Invoice No.",
      [invoice.invoiceNumber],
      refs?.invoice ? [refs.invoice] : [],
      Boolean(refs),
      undefined,
      true,
    ),
  );
  if (invoice.eWayBill || refs?.eWayBill)
    rows.push(
      compare(
        "E-Way Bill No.",
        invoice.eWayBill ? [invoice.eWayBill] : [],
        refs?.eWayBill ? [refs.eWayBill] : [],
        Boolean(refs),
        invoice.referenceSources?.eWayBill ?? undefined,
      ),
    );
  if (invoice.lorryReceipt || refs?.lorryReceipt)
    rows.push(
      compare(
        "Lorry Receipt No.",
        invoice.lorryReceipt ? [invoice.lorryReceipt] : [],
        refs?.lorryReceipt ? [refs.lorryReceipt] : [],
        Boolean(refs),
        invoice.referenceSources?.lorryReceipt ?? undefined,
      ),
    );
  if (invoice.vehicles.length || candidate.vehicle)
    rows.push(
      compare(
        "Vehicle No.",
        invoice.vehicles,
        candidate.vehicle ? [candidate.vehicle] : [],
        true,
        invoice.referenceSources?.vehicles
          .map((entry) => `${entry.value}: ${entry.source}`)
          .join("; "),
      ),
    );
  return rows;
}

/** Historical results never recorded a period check. Do not present their default pass as verification. */
export function truthfulChecks(result: MatchResult): MatchCheck[] {
  return result.checks.map((check) => {
    if (check.sev !== "pass" || check.decision) return check;
    const notChecked =
      /not checked|could not be verified|No PO rate to compare against/i.test(
        check.title,
      ) ||
      (check.id === "period" && !result.checkedAt) ||
      (check.id === "total" &&
        (result.payload?.invoiceTaxable == null ||
          result.payload?.difference == null));
    return notChecked
      ? {
          ...check,
          sev: "unchecked",
          open: false,
          title:
            check.id === "period"
              ? "Posting Period not checked (not recorded in this saved comparison)"
              : check.id === "total"
                ? "Invoice total not checked (comparison values are unavailable)"
                : check.title,
        }
      : check;
  });
}

export function quantityBalances(line: LineResult) {
  const selected = line.candidates.filter(
    (candidate) => candidate.allocated > 0,
  );
  const received = selected.reduce(
    (sum, candidate) => sum + candidate.quantity,
    0,
  );
  const available = selected.reduce(
    (sum, candidate) => sum + candidate.open,
    0,
  );
  const used = selected.reduce(
    (sum, candidate) => sum + candidate.allocated,
    0,
  );
  return {
    received,
    available,
    used,
    remaining: Math.max(0, Math.round((available - used) * 1000) / 1000),
  };
}

export function itemIdentificationLabel(line: LineResult) {
  const identification = line.itemIdentification;
  return !identification
    ? "Identification method not recorded"
    : identification.method === "exact-code"
      ? "Exact invoice item code found in SAP Item Master"
      : identification.scope === "shared"
        ? "Saved shared item mapping"
        : identification.scope === "supplier"
          ? "Saved supplier item mapping"
          : "Saved item mapping";
}

export function matchTimestamp(value: string | null | undefined) {
  if (!value) return "Time not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time not recorded"
    : date.toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
