export function sapBaseRequiresMaterialForm(baseKind: unknown): boolean {
  return (
    String(baseKind ?? "")
      .trim()
      .toUpperCase() !== "PO"
  );
}
