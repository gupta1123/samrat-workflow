export type SapDocumentSnapshot = {
  readAt: string;
  document: Record<string, unknown>;
};

export const SAP_HEADER_FIELDS = [
  { key: "U_TATAINV", label: "Supplier invoice number", group: "document" },
  { key: "U_TATAINVDT", label: "Supplier invoice date", group: "document" },
  { key: "U_TRSPRT", label: "Transporter", group: "transport" },
  { key: "U_MTRFORM", label: "Material form", group: "transport" },
  { key: "U_TATKTW", label: "Supplier Kata weight (MT)", group: "transport" },
  { key: "U_SAMKTW", label: "Samrat Kata weight (MT)", group: "transport" },
  { key: "U_TOTQTY", label: "Total invoice quantity", group: "transport" },
] as const;

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Keep posting fields only; exclude unrelated SAP response internals. */
export function sapDocumentSnapshot(
  value: unknown,
  readAt = new Date().toISOString(),
): SapDocumentSnapshot {
  const source = object(value);
  const keys = [
    "DocEntry",
    "DocNum",
    "DocObjectCode",
    "DocumentSubType",
    "DocType",
    "CardCode",
    "CardName",
    "Comments",
    "DocCurrency",
    "DocDate",
    "TaxDate",
    "NumAtCard",
    "DocTotal",
    "VatSum",
    "RoundingDiffAmount",
    "TotalDiscount",
    "TotalExpenses",
    "Cancelled",
    "DocumentStatus",
  ];
  const document: Record<string, unknown> = {};
  for (const key of [
    ...keys,
    ...Object.keys(source).filter((key) => key.startsWith("U_")),
  ]) {
    const value = source[key];
    if (
      value === null ||
      ["string", "number", "boolean"].includes(typeof value)
    )
      document[key] = value;
  }
  for (const [key, fields] of [
    [
      "DocumentLines",
      [
        "LineNum",
        "ItemCode",
        "ItemDescription",
        "Quantity",
        "UnitPrice",
        "Price",
        "LineTotal",
        "MeasureUnit",
        "UoMCode",
        "TaxCode",
        "VatGroup",
        "BaseType",
        "BaseEntry",
        "BaseLine",
      ],
    ],
    [
      "WithholdingTaxDataCollection",
      ["WTCode", "Rate", "WTAmount", "TaxableAmount"],
    ],
    ["DocumentAdditionalExpenses", ["ExpenseCode", "LineTotal", "TaxCode"]],
  ] as const) {
    if (Array.isArray(source[key]))
      document[key] = source[key].map((row) =>
        Object.fromEntries(
          fields
            .filter((field) => field in object(row))
            .map((field) => [field, object(row)[field]]),
        ),
      );
  }
  return { readAt, document };
}

export function previewSource(
  source: string | undefined,
): "PDF" | "SAP" | "Selected" | "Saved" {
  if (source === "SAP") return "SAP";
  if (/selected/i.test(source ?? "")) return "Selected";
  if (/scanned|weighment|pdf/i.test(source ?? "")) return "PDF";
  return "Saved";
}

export function assertSapPostingIdentity(
  value: unknown,
  expected: { entry: number; vendor: string; invoice: string; draft: boolean },
) {
  const row = object(value);
  if (
    row.DocEntry !== expected.entry ||
    row.CardCode !== expected.vendor ||
    row.NumAtCard !== expected.invoice ||
    (expected.draft &&
      !["18", "oPurchaseInvoices"].includes(String(row.DocObjectCode)))
  )
    throw new Error("SAP returned a document that does not match this case.");
}
