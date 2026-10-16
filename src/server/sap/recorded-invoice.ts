import type { RecordedInvoiceEvidence } from "@/lib/sap-match/types";

const text = (value: unknown) =>
  typeof value === "string" && value.length ? value : null;
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Only expose lines from the exact, non-cancelled document found by SAP's
 * supplier + invoice-reference lookup. No product matching or grouping occurs.
 */
export function recordedInvoiceEvidence(
  document: Record<string, unknown>,
  expected: {
    docEntry: number;
    docNum: string | number;
    cardCode: string;
    invoiceReference: string;
  },
): RecordedInvoiceEvidence | null {
  if (
    document.DocEntry !== expected.docEntry ||
    document.DocNum !== expected.docNum ||
    document.CardCode !== expected.cardCode ||
    document.NumAtCard !== expected.invoiceReference ||
    document.Cancelled !== "tNO" ||
    !Array.isArray(document.DocumentLines)
  )
    return null;

  const lines = document.DocumentLines;
  if (
    lines.some(
      (line) => !line || typeof line !== "object" || Array.isArray(line),
    )
  )
    return null;

  return {
    ...expected,
    currency: text(document.DocCurrency),
    total: number(document.DocTotal),
    docDate: text(document.DocDate)?.slice(0, 10) ?? null,
    taxTotal: number(document.VatSum),
    lines: lines.map((line: Record<string, unknown>) => ({
      lineNum: number(line.LineNum),
      itemCode: text(line.ItemCode),
      description: text(line.ItemDescription),
      accountCode: text(line.AccountCode),
      quantity: number(line.Quantity),
      unitPrice: number(line.UnitPrice),
      lineTotal: number(line.LineTotal),
      base: baseOf(line),
    })),
  };
}

/** SAP's own record of the document a line was posted against. Nothing is inferred. */
function baseOf(line: Record<string, unknown>) {
  const entry = number(line.BaseEntry);
  const kind =
    line.BaseType === 22 ? "PO" : line.BaseType === 20 ? "GRPO" : null;
  if (!kind || entry === null) return null;
  return {
    kind,
    docEntry: entry,
    docNum: null,
    lineNum: number(line.BaseLine),
  } as const;
}
