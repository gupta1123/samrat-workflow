/** Display-only identity. Never use this fallback for approval, SAP matching or posting. */
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const unique = (values: string[]) => {
  const entries = [...new Set(values.filter(Boolean))];
  return entries.length === 1 ? entries[0] : "";
};

export function caseDisplayIdentity(params: {
  displayName?: string | null;
  processingMeta?: unknown;
}) {
  const meta = record(params.processingMeta);
  const audits = list(record(meta.extractionReview).documentAudits)
    .map(record)
    .filter(
      (audit) => audit.status === "verified" || audit.status === "corrected",
    );
  const supplier = unique(
    audits.flatMap((audit) =>
      list(audit.fieldEvidence)
        .map(record)
        .filter(
          (entry) =>
            entry.field === "vendorName" &&
            Object.keys(record(entry.evidence)).length > 0,
        )
        .map((entry) => text(entry.value)),
    ),
  );
  const reference = unique(
    audits.flatMap((audit) =>
      list(audit.referenceEvidence)
        .map(record)
        .filter((entry) => entry.field === "invoiceNumber" && text(entry.quote))
        .map((entry) => text(entry.value)),
    ),
  );
  const files = [
    ...new Set(
      list(meta.verificationGroups)
        .flatMap((group) => list(record(group).sourceFileNames).map(text))
        .filter(Boolean),
    ),
  ];
  const fallback =
    files.length === 1
      ? files[0]
      : files.length > 1
        ? `${files.length} uploaded files`
        : "Document review pending";
  const stored = text(params.displayName);
  const displayName =
    stored && stored !== "Case" && stored !== "New case"
      ? stored
      : [supplier || fallback, reference].filter(Boolean).join(" / ");
  return { displayName, displayInvoiceNumber: reference || null };
}
