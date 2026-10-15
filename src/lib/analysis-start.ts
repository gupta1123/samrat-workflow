type AnalysisStartPayload = {
  case?: { status?: unknown } | null;
  job?: { id?: unknown; status?: unknown } | null;
};

export const ANALYSIS_START_ERRORS = {
  analysis_daily_limit:
    "Today's analysis limit has been reached. Your documents are saved; please start this case again tomorrow.",
  analysis_documents_required:
    "Add at least one document to this case before starting analysis.",
  analysis_split_case:
    "This packet has already been split into cases. Upload only the corrected documents as a new case to avoid duplicating them.",
  analysis_start_rejected:
    "Analysis could not start yet. Your documents are saved. Open the saved case, check its documents and try again.",
  analysis_start_unconfirmed:
    "We could not confirm that analysis started. Your documents are saved; open the saved case to check its status before retrying.",
} as const;

export type AnalysisStartErrorCode = keyof typeof ANALYSIS_START_ERRORS;
export function isAnalysisStartErrorCode(
  code: unknown,
): code is AnalysisStartErrorCode {
  return typeof code === "string" && Object.hasOwn(ANALYSIS_START_ERRORS, code);
}

/** Typed start failures are distinct from failures while reading documents. */
export function getFriendlyAnalysisStartError(error: unknown) {
  const details =
    error && typeof error === "object"
      ? (error as { code?: unknown; isAuthError?: unknown })
      : {};
  if (details.isAuthError === true)
    return "Your session has expired. Sign in again; your uploaded documents are saved.";
  return isAnalysisStartErrorCode(details.code)
    ? ANALYSIS_START_ERRORS[details.code]
    : ANALYSIS_START_ERRORS.analysis_start_unconfirmed;
}

type ConfirmedAnalysisStart<T extends AnalysisStartPayload> = T & {
  case: NonNullable<T["case"]> & { status: "processing" };
  job: NonNullable<T["job"]> & {
    id: string;
    status: "queued" | "running";
  };
};

export function isConfirmedAnalysisStart<T extends AnalysisStartPayload>(
  value: T | null | undefined,
): value is ConfirmedAnalysisStart<T> {
  if (!value || typeof value !== "object") return false;

  const payload = value as AnalysisStartPayload;
  return (
    payload.case?.status === "processing" &&
    typeof payload.job?.id === "string" &&
    payload.job.id.length > 0 &&
    (payload.job.status === "queued" || payload.job.status === "running")
  );
}
