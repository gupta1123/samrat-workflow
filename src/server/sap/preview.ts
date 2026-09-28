import { parseSapAmount } from "@/lib/sap-decision";
import type { SapPacketLine } from "./posting";

type InvoiceDocument = { extracted_fields: unknown };

function amount(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/\d/.test(value))) return null;
  return parseSapAmount(value);
}

function sumDocumentField(documents: InvoiceDocument[], field: string): number | null {
  if (documents.length === 0) return null;
  const values = documents.map((document) =>
    amount((document.extracted_fields as Record<string, unknown> | null)?.[field]),
  );
  return values.every((value): value is number => value !== null)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

function sumAll(values: Array<number | null>): number | null {
  return values.length > 0 && values.every((value): value is number => value !== null)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

/** Prefer the invoice's printed header totals; never turn absent money into zero. */
export function invoiceMoneyPreview(documents: InvoiceDocument[], packetLines: SapPacketLine[]) {
  const headerTaxable = sumDocumentField(documents, "subtotal");
  const headerTax = sumDocumentField(documents, "taxAmount");
  const headerTotal = sumDocumentField(documents, "totalAmount");
  const lineTotals = packetLines.map((line) => amount(line.lineTotal));
  const printedLinesMatchSubtotal = headerTaxable !== null &&
    (sumAll(lineTotals) !== null) &&
    Math.abs(sumAll(lineTotals)! - headerTaxable) <= 0.02;
  const lines = packetLines.map((line, index) => ({
    rate: amount(line.rate),
    taxableAmount: amount(line.taxableAmount) ??
      (printedLinesMatchSubtotal ? lineTotals[index] : null),
    taxAmount: amount(line.taxAmount),
  }));
  const taxable = headerTaxable ?? sumAll(lines.map((line) => line.taxableAmount));
  const tax = headerTax ?? sumAll(lines.map((line) => line.taxAmount)) ??
    (headerTotal !== null && taxable !== null ? headerTotal - taxable : null);
  const total = headerTotal ?? (taxable !== null && tax !== null ? taxable + tax : null);
  return { lines, totals: { taxable, tax, total } };
}
