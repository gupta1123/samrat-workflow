export const SAP_NON_MATERIAL_FORM = "ST";

function normalizedBaseKind(baseKind: unknown): string {
  return String(baseKind ?? "")
    .trim()
    .toUpperCase();
}

export function sapBaseRequiresMaterialForm(baseKind: unknown): boolean {
  return normalizedBaseKind(baseKind) !== "PO";
}

export function sapAutomaticMaterialForm(baseKind: unknown): string | null {
  return normalizedBaseKind(baseKind) === "PO" ? SAP_NON_MATERIAL_FORM : null;
}
