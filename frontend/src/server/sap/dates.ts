const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  )
    return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Invoice dates are read from Indian vendor documents, where numeric dates are day-first. */
export function sapInvoiceDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const numeric = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (numeric)
    return validDate(
      Number(numeric[3]),
      Number(numeric[2]),
      Number(numeric[1]),
    );

  const named = text.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (named) {
    const month = MONTHS[named[2].slice(0, 3).toLowerCase()];
    return month ? validDate(Number(named[3]), month, Number(named[1])) : null;
  }
  return null;
}

/** The Test company and its users operate in India; don't use the server's UTC date. */
export function sapPostingDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function indianFinancialYearBounds(date: string) {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  return {
    start: `${startYear}-04-01`,
    end: `${startYear + 1}-03-31`,
  };
}

/**
 * SAP Test is a historical sandbox and may not have currency rates maintained
 * for a newly uploaded invoice date. Prefer the newest date already used by a
 * Test A/P invoice, never cross a financial year, and never precede the base
 * purchasing document. The vendor invoice date remains unchanged as TaxDate.
 */
export function sapTestPostingDateCandidates(params: {
  invoiceDate: string;
  baseDocumentDate?: string | null;
  existingInvoiceDates: Array<string | null | undefined>;
}): string[] {
  const invoiceDate = sapInvoiceDate(params.invoiceDate);
  if (!invoiceDate) return [];
  const financialYear = indianFinancialYearBounds(invoiceDate);
  const normalizedBaseDate = sapInvoiceDate(params.baseDocumentDate);
  const earliest =
    normalizedBaseDate && normalizedBaseDate > financialYear.start
      ? normalizedBaseDate
      : financialYear.start;

  return [
    ...new Set(
      params.existingInvoiceDates
        .map((date) => sapInvoiceDate(date))
        .filter((date): date is string => Boolean(date))
        .filter(
          (date) =>
            date < invoiceDate && date >= earliest && date <= financialYear.end,
        ),
    ),
  ].sort((left, right) => right.localeCompare(left));
}
