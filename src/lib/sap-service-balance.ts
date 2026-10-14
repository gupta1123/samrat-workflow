/** SAP's service OpenAmount is local currency; OpenAmountFC is document
 * foreign currency. Never compare a local balance to a foreign invoice. */
export function serviceOpenBalance(
  line: Record<string, unknown>,
  documentCurrency: unknown,
  localCurrency: unknown,
): number | null {
  if (line.LineStatus !== "bost_Open") return 0;
  if (
    typeof documentCurrency !== "string" ||
    typeof localCurrency !== "string" ||
    !documentCurrency ||
    !localCurrency
  )
    return null;
  const key =
    documentCurrency.trim().toUpperCase() === localCurrency.trim().toUpperCase()
      ? "OpenAmount"
      : "OpenAmountFC";
  const raw = line[key];
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
