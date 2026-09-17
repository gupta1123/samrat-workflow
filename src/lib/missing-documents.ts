import type { Mismatch } from "@/types/pipeline";

export const MISSING_DOCUMENTS_FIELD = "missingDocuments";

function uniqueLabels(labels: string[]) {
  return Array.from(
    new Set(labels.map((label) => label.trim()).filter(Boolean)),
  );
}

export function readMissingDocumentGroups(processingMeta: unknown) {
  if (
    !processingMeta ||
    typeof processingMeta !== "object" ||
    Array.isArray(processingMeta)
  ) {
    return [];
  }

  const value = (processingMeta as Record<string, unknown>)
    .missingDocumentGroups;
  if (!Array.isArray(value)) return [];

  return uniqueLabels(
    value.map((entry) => (typeof entry === "string" ? entry : "")),
  );
}

export function buildMissingDocumentIssues(
  missingDocumentGroups: string[],
): Mismatch[] {
  const missing = uniqueLabels(missingDocumentGroups);
  if (!missing.length) return [];

  const list = missing.join(", ");
  return [
    {
      id: "missing-required-documents",
      field: MISSING_DOCUMENTS_FIELD,
      values: [
        {
          docId: "packet",
          value: `Missing required documents: ${list}`,
        },
      ],
      analysis: `This case is incomplete because the following required document groups are missing: ${list}.`,
      fixPlan: `Upload ${list}, then run the analysis again.`,
    },
  ];
}
