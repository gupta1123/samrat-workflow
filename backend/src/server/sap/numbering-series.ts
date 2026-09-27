export type SapNumberedApInvoice = {
  DocEntry?: number;
  DocDate?: string;
  Series?: number;
  DocumentSubType?: string;
  BPL_IDAssignedToInvoice?: number | null;
  Cancelled?: string;
};

export type SapNumberingSeries = {
  Series?: number;
  Document?: string;
  DocumentSubType?: string;
  Locked?: string;
  PeriodIndicator?: string;
  BPLID?: number | null;
  NextNumber?: number;
  LastNumber?: number | null;
};

type SeriesSelection = {
  postingDate: string;
  branchId?: number | null;
  invoices: SapNumberedApInvoice[];
};

type ConfiguredSeriesSelection = {
  branchId?: number | null;
  periodIndicator?: string | null;
  defaultSeries?: number | null;
  historicalSeries?: number | null;
  series: SapNumberingSeries[];
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

function validConfiguredSeries(
  candidate: SapNumberingSeries,
  periodIndicator?: string | null,
): candidate is SapNumberingSeries & { Series: number } {
  const number = Number(candidate.Series);
  const next = Number(candidate.NextNumber);
  const last = candidate.LastNumber == null ? null : Number(candidate.LastNumber);
  return (
    Number.isInteger(number) &&
    number > 0 &&
    (candidate.Document == null || String(candidate.Document) === "18") &&
    candidate.DocumentSubType?.toUpperCase() === "GA" &&
    candidate.Locked !== "tYES" &&
    (!periodIndicator || candidate.PeriodIndicator === periodIndicator) &&
    (last === null || last <= 0 || !Number.isFinite(next) || next <= last)
  );
}

/** Select only a configured, unlocked GST A/P Invoice series for the right period and branch. */
export function selectConfiguredGstApInvoiceSeries({
  branchId,
  periodIndicator,
  defaultSeries,
  historicalSeries,
  series,
}: ConfiguredSeriesSelection): number | null {
  const valid = series.filter((candidate) =>
    validConfiguredSeries(candidate, periodIndicator),
  );
  const exactBranch = Number.isInteger(branchId)
    ? valid.filter((candidate) => candidate.BPLID === branchId)
    : [];
  const global = valid.filter(
    (candidate) => candidate.BPLID == null || candidate.BPLID === -1,
  );
  const candidates = exactBranch.length > 0
    ? exactBranch
    : Number.isInteger(branchId)
      ? global
      : valid;
  if (candidates.length === 1) return candidates[0].Series;

  for (const preferred of [defaultSeries, historicalSeries]) {
    if (!Number.isInteger(preferred)) continue;
    if (candidates.some((candidate) => candidate.Series === preferred)) {
      return preferred!;
    }
  }
  return null;
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
