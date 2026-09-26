export const SAP_NON_MATERIAL_FORM = "ST";

function normalizedBaseKind(baseKind: unknown): string {
  return String(baseKind ?? "")
    .trim()
    .toUpperCase();
}

export type SapItemInventoryState = {
  InventoryItem?: string;
};

export function sapMaterialFormPolicy(
  baseKind: unknown,
  items: SapItemInventoryState[] = [],
): { required: boolean; automaticValue: string | null } {
  if (normalizedBaseKind(baseKind) !== "PO") {
    return { required: true, automaticValue: null };
  }

  const containsInventoryItem = items.some(
    (item) => item.InventoryItem === "tYES",
  );
  return containsInventoryItem
    ? { required: true, automaticValue: null }
    : { required: false, automaticValue: SAP_NON_MATERIAL_FORM };
}
