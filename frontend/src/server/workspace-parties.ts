function normalizeValue(value?: string | null) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function normalizeMatchKey(value: string) {
  return normalizeValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Workspace identity is deployment configuration, not document-analysis logic.
 * A dedicated installation can list its own legal/trading names without teaching
 * the verifier anything about a particular supplier, invoice, or case.
 */
export function getInternalCompanyNameHints() {
  const configured =
    process.env.INTERNAL_COMPANY_NAMES ??
    process.env.CASE_NAMING_INTERNAL_HINTS ??
    "";

  return configured
    .split(",")
    .map((value) => normalizeValue(value))
    .filter(Boolean);
}

export function isInternalCompanyName(
  value?: string | null,
  hints = getInternalCompanyNameHints(),
) {
  const key = normalizeMatchKey(normalizeValue(value));
  if (!key) return false;

  return hints
    .map((hint) => normalizeMatchKey(hint))
    .filter(Boolean)
    .some((hint) => key.includes(hint) || hint.includes(key));
}
