import type { CaseDoc, Mismatch } from "@/types/pipeline";

export const EWAY_BILL_VALIDITY_FIELD = "eWayBillValidity";

export function indiaCalendarDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function digits(value: string) {
  return (
    value.length > 0 &&
    Array.from(value).every((char) => char >= "0" && char <= "9")
  );
}

function calendarDate(year: string, month: string, day: string): string | null {
  if (year.length !== 4 || ![year, month, day].every(digits)) return null;
  const y = Number(year),
    m = Number(month),
    d = Number(day);
  if (y < 1000 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  )
    return null;
  return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Explicit date grammar, not locale-dependent Date.parse or inferred dates.
// ISO YYYY-MM-DD; Indian DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY;
// DD Mon YYYY / DD-Month-YYYY. Printed time is irrelevant to a date-only check.
export function parseEWayBillValidityDate(value: string): string | null {
  const text = value.trim();
  const words = text.split(" ").filter(Boolean);
  const first = words[0] ?? "";
  const isoDate = first.split("T")[0];
  for (const separator of ["/", ".", "-"]) {
    const parts = isoDate.split(separator);
    if (parts.length !== 3) continue;
    const [a, b, c] = parts;
    if (a.length === 4 && separator === "-") return calendarDate(a, b, c);
    if (digits(b)) return calendarDate(c, b, a);
    return calendarDate(c, monthNumber(b), a);
  }
  if (words.length >= 3)
    return calendarDate(words[2], monthNumber(words[1]), words[0]);
  return null;
}

function monthNumber(value: string): string {
  for (let month = 1; month <= 12; month++) {
    const date = new Date(Date.UTC(2000, month - 1, 1));
    for (const style of ["short", "long"] as const) {
      const name = new Intl.DateTimeFormat("en-GB", {
        month: style,
        timeZone: "UTC",
      }).format(date);
      if (name.toLowerCase() === value.toLowerCase()) return String(month);
    }
  }
  return "";
}

export function buildEWayBillValidityIssues(
  documents: CaseDoc[],
  now = new Date(),
): Mismatch[] {
  const today = indiaCalendarDate(now);
  return documents.flatMap((doc): Mismatch[] => {
    if (doc.type !== "E-Way Bill") return [];
    const printed = doc.fields.validityDate?.trim() ?? "";
    const expiry = parseEWayBillValidityDate(printed);
    if (expiry && expiry >= today) return [];
    const description = expiry
      ? `E-Way Bill expired: Valid Upto ${printed} (${expiry}) is before today's date ${today} in India.`
      : `E-Way Bill expiry could not be checked: the printed Valid Upto date is ${printed ? "not a supported, unambiguous calendar date" : "missing or unreadable"}. It has not been assumed expired.`;
    return [
      {
        // Today's date is intentionally excluded: reopening must not reset a decision.
        id: `eway-validity:${doc.id}:${expiry ?? encodeURIComponent(printed)}`,
        field: EWAY_BILL_VALIDITY_FIELD,
        values: [
          {
            docId: doc.id,
            value: printed || "Valid Upto date missing or unreadable",
            evidenceField: "validityDate",
            sourceFileName: doc.sourceFileName,
            pageNumber: doc.sourcePageNumbers?.[0],
          },
        ],
        analysis: description,
        fixPlan:
          "Review the e-way bill validity. Accept this issue to acknowledge the warning and continue, or reject it to mark it as disputed. Upload a corrected document and reanalyse if needed.",
      },
    ];
  });
}
