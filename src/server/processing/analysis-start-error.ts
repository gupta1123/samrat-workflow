import { ApiError } from "@/server/api/helpers";
import {
  ANALYSIS_START_ERRORS,
  isAnalysisStartErrorCode,
} from "@/lib/analysis-start";

/** Read only structured application errors; never classify diagnostic text. */
export function analysisStartDatabaseError(
  error: { code?: string; details?: string | null } | null,
) {
  if (!error || !["P0001", "PT429"].includes(error.code ?? "")) return null;
  let details: unknown;
  try {
    details = error.details ? JSON.parse(error.details) : null;
  } catch {
    details = null;
  }
  const code =
    details &&
    typeof details === "object" &&
    "code" in details &&
    isAnalysisStartErrorCode(details.code)
      ? details.code
      : "analysis_start_rejected";
  return new ApiError(
    ANALYSIS_START_ERRORS[code],
    error.code === "PT429" ? 429 : 409,
    { code },
  );
}
