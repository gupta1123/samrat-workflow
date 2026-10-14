import type { LogisticsRow, LogisticsRowField } from "@/types/pipeline";

export const LOGISTICS_ROWS_FIELD_KEY = "__logisticsRows";
export const LOGISTICS_ROW_FIELDS: readonly LogisticsRowField[] = [
  "vehicleNumber",
  "transportMode",
  "transporterName",
  "documentDate",
  "lorryReceiptNumber",
  "deliveryNoteNumber",
  "deliveryOrderNumber",
  "referenceInvoiceNumber",
  "referencePoNumber",
  "itemCode",
  "description",
  "quantity",
  "unit",
  "grossWeight",
  "tareWeight",
  "netWeight",
  "weightUnit",
];

/** Structural decoding only. Never derives or rewrites source values. */
export function readLogisticsRows(raw: unknown): LogisticsRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    if (row.kind !== "transport" && row.kind !== "weighment") return [];
    if (!Number.isInteger(row.sourcePage) || Number(row.sourcePage) < 1)
      return [];
    const source = row.values as Record<string, unknown> | undefined;
    if (!source || typeof source !== "object" || Array.isArray(source))
      return [];
    const values = Object.fromEntries(
      LOGISTICS_ROW_FIELDS.flatMap((field) =>
        typeof source[field] === "string" && source[field].trim()
          ? [[field, source[field]]]
          : [],
      ),
    );
    if (!Object.keys(values).length) return [];
    const proof = row.evidence as Record<string, unknown> | undefined;
    const evidence = Object.fromEntries(
      Object.keys(values).flatMap((field) =>
        proof && typeof proof[field] === "string"
          ? [[field, proof[field]]]
          : [],
      ),
    );
    return [
      {
        kind: row.kind,
        values,
        sourcePage: Number(row.sourcePage),
        ...(Object.keys(evidence).length ? { evidence } : {}),
      },
    ];
  });
}

export function readStoredLogisticsRows(fields: unknown): LogisticsRow[] {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return [];
  return readLogisticsRows(
    (fields as Record<string, unknown>)[LOGISTICS_ROWS_FIELD_KEY],
  );
}
