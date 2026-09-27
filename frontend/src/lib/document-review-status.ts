type DocumentMismatch = {
  id?: string;
  values?: Array<{ docId?: string | null; isOutlier?: boolean }>;
};

export function getDocumentIssueCount(
  documentIdentifiers: Array<string | null | undefined>,
  mismatches: DocumentMismatch[],
) {
  const identifiers = new Set(
    documentIdentifiers.filter(
      (identifier): identifier is string =>
        typeof identifier === "string" && Boolean(identifier.trim()),
    ),
  );
  if (!identifiers.size) return 0;

  return mismatches.filter((mismatch) => {
    const values = mismatch.values ?? [];
    const hasAuthoritativeAttribution = values.some(
      (entry) => typeof entry.isOutlier === "boolean",
    );
    const relevantValues = hasAuthoritativeAttribution
      ? values.filter((entry) => entry.isOutlier === true)
      : values;

    return relevantValues.some(
      (entry) => Boolean(entry.docId) && identifiers.has(entry.docId!),
    );
  }).length;
}
