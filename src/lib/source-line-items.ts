import type { CommercialLineItem } from "@/types/pipeline";

export const SOURCE_LINE_ITEM_KEYS: readonly (keyof CommercialLineItem)[] = [
  "lineNumber",
  "itemCode",
  "description",
  "hsnSac",
  "quantity",
  "unit",
  "rate",
  "discountPercent",
  "netRate",
  "taxableAmount",
  "cgstRate",
  "cgstAmount",
  "sgstRate",
  "sgstAmount",
  "igstRate",
  "igstAmount",
  "taxRate",
  "taxAmount",
  "lineTotal",
  "referencePoLineNumber",
  "referencePoNumber",
  "referenceGrpoNumber",
  "rawText",
  "sourcePage",
];

/** Decode a source-reviewed table without semantic cleanup or inferred values. */
export function decodeSourceLineItems(raw: unknown): CommercialLineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const source = entry as Record<string, unknown>;
    const item = Object.fromEntries(
      SOURCE_LINE_ITEM_KEYS.flatMap<[string, unknown]>((key) => {
        const value = source[key];
        if (key === "sourcePage")
          return Number.isInteger(value) && Number(value) > 0
            ? [[key, value]]
            : [];
        return typeof value === "string" && value.trim() ? [[key, value]] : [];
      }),
    ) as CommercialLineItem;
    return Object.keys(item).length ? [item] : [];
  });
}
