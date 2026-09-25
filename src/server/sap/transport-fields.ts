const TRANSPORT_FIELD = /^U_.*(?:transport|transp|trsprt)/i;
const EMPTY_SAP_VALUES = new Set(["", "-", "NA", "N/A", "NONE", "NULL"]);

function usableSapText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !EMPTY_SAP_VALUES.has(value.trim().toUpperCase())
  );
}

/**
 * Copy transport UDFs from the exact SAP base document into a draft when SAP
 * left the corresponding draft field empty. Values always come from SAP.
 */
export function sapTransportFieldUpdates(
  draft: Record<string, unknown>,
  baseDocument: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(baseDocument).filter(
      ([key, value]) =>
        TRANSPORT_FIELD.test(key) &&
        usableSapText(value) &&
        !usableSapText(draft[key]),
    ),
  ) as Record<string, string>;
}

export function transportFieldsMatch(
  document: Record<string, unknown>,
  expected: Record<string, string>,
): boolean {
  return Object.entries(expected).every(
    ([key, value]) =>
      typeof document[key] === "string" &&
      document[key].trim() === value.trim(),
  );
}
