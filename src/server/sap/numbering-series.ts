export type SapNumberedApInvoice = {
  DocEntry?: number;
  DocDate?: string;
  Series?: number;
  DocumentSubType?: string;
  BPL_IDAssignedToInvoice?: number | null;
  Cancelled?: string;
};

type SeriesSelection = {
  postingDate: string;
  branchId?: number | null;
  invoices: SapNumberedApInvoice[];
};

function dateValue(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const parsed = Date.parse(`${normalized}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function isGstTaxInvoice(value: unknown): boolean {
  return String(value ?? "").toLowerCase() === "bod_gsttaxinvoice";
}

/**
 * SAP GST invoices use their own statutory numbering series. If the Service
 * Layer user has no default series, reuse the series SAP already used for the
 * closest GST A/P invoice in the same branch and financial year.
 */
export function selectExistingGstApInvoiceSeries({
  postingDate,
  branchId,
  invoices,
}: SeriesSelection): number | null {
  const targetDate = dateValue(postingDate);
  if (targetDate === null) return null;

  const candidates = invoices.flatMap((invoice) => {
    const invoiceDate = dateValue(invoice.DocDate);
    const series = Number(invoice.Series);
    if (
      invoiceDate === null ||
      !Number.isInteger(series) ||
      series <= 0 ||
      invoice.Cancelled === "tYES" ||
      !isGstTaxInvoice(invoice.DocumentSubType)
    ) {
      return [];
    }
    if (
      Number.isInteger(branchId) &&
      invoice.BPL_IDAssignedToInvoice !== branchId
    ) {
      return [];
    }
    return [
      {
        series,
        exactDate: invoiceDate === targetDate,
        distance: Math.abs(invoiceDate - targetDate),
        docEntry: Number(invoice.DocEntry) || 0,
      },
    ];
  });

  candidates.sort(
    (left, right) =>
      Number(right.exactDate) - Number(left.exactDate) ||
      left.distance - right.distance ||
      right.docEntry - left.docEntry,
  );
  if (
    !Number.isInteger(branchId) &&
    new Set(candidates.map((candidate) => candidate.series)).size > 1
  ) {
    return null;
  }
  return candidates[0]?.series ?? null;
}

export function indianFinancialYear(date: string): {
  start: string;
  end: string;
} {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  if (!match)
    throw new Error(
      "A valid posting date is required to resolve the SAP numbering series.",
    );
  const year = Number(match[1]);
  const month = Number(match[2]);
  const startYear = month >= 4 ? year : year - 1;
  return {
    start: `${startYear}-04-01`,
    end: `${startYear + 1}-03-31`,
  };
}
