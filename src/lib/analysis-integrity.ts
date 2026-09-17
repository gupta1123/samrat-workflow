export const ANALYSIS_INTEGRITY_VERSION = 1;

export type AnalysisIntegrityAudit = {
  docId: string;
  status: "verified" | "corrected" | "needs_review";
};

export type AnalysisIntegrityPageAssessment = {
  approvalSafe: boolean;
};

export type AnalysisIntegrityRecord = {
  version: number;
  status: "verified" | "blocked";
  extractionSucceeded: boolean;
  authoritativeReviewCompleted: boolean;
  documentCount: number;
  auditedDocumentCount: number;
  assessedPageCount: number;
  unsafePageCount: number;
  unresolvedDocumentCount: number;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function buildAnalysisIntegrityRecord(params: {
  documentIds: string[];
  documentAudits: AnalysisIntegrityAudit[];
  pageQuality: AnalysisIntegrityPageAssessment[];
}): AnalysisIntegrityRecord {
  const documentIds = new Set(params.documentIds);
  const auditedDocumentIds = new Set(
    params.documentAudits
      .map((audit) => audit.docId)
      .filter((docId) => documentIds.has(docId)),
  );
  const unresolvedDocumentCount = params.documentAudits.filter(
    (audit) =>
      documentIds.has(audit.docId) && audit.status === "needs_review",
  ).length;
  const unsafePageCount = params.pageQuality.filter(
    (assessment) => !assessment.approvalSafe,
  ).length;
  const authoritativeReviewCompleted =
    documentIds.size > 0 && auditedDocumentIds.size === documentIds.size;
  const status =
    authoritativeReviewCompleted &&
    params.pageQuality.length > 0 &&
    unsafePageCount === 0 &&
    unresolvedDocumentCount === 0
      ? "verified"
      : "blocked";

  return {
    version: ANALYSIS_INTEGRITY_VERSION,
    status,
    extractionSucceeded: true,
    authoritativeReviewCompleted,
    documentCount: documentIds.size,
    auditedDocumentCount: auditedDocumentIds.size,
    assessedPageCount: params.pageQuality.length,
    unsafePageCount,
    unresolvedDocumentCount,
  };
}

export function getAnalysisIntegrityApprovalBlockReason(
  processingMeta: unknown,
): string | null {
  const meta = record(processingMeta);
  const integrity = record(meta.analysisIntegrity);

  if (
    integrity.version !== ANALYSIS_INTEGRITY_VERSION ||
    integrity.extractionSucceeded !== true ||
    integrity.authoritativeReviewCompleted !== true ||
    integrity.status !== "verified"
  ) {
    return "Document reading and extraction were not fully verified. Run the analysis again before approval.";
  }

  if (
    Number(integrity.documentCount) < 1 ||
    Number(integrity.auditedDocumentCount) !== Number(integrity.documentCount)
  ) {
    return "Not every extracted document was verified. Run the analysis again before approval.";
  }

  if (
    Number(integrity.assessedPageCount) < 1 ||
    Number(integrity.unsafePageCount) > 0 ||
    Number(integrity.unresolvedDocumentCount) > 0
  ) {
    return "One or more source pages could not be read safely. Replace the affected document and analyze again before approval.";
  }

  const extractionReview = record(meta.extractionReview);
  if (
    extractionReview.enabled !== true ||
    extractionReview.required !== true ||
    extractionReview.authoritative !== true
  ) {
    return "The required extraction review did not complete. Run the analysis again before approval.";
  }

  const lastProcessingError = meta.lastProcessingError;
  if (
    lastProcessingError !== null &&
    lastProcessingError !== undefined &&
    String(lastProcessingError).trim()
  ) {
    return "The latest analysis contains a processing error. Retry analysis before approval.";
  }

  return null;
}
