import {
  ApiError,
  dbCheck,
  jsonBody,
  mapCase,
  ownedCase,
  uuid,
  withUser,
} from "@/server/api/helpers";
import {
  DEFAULT_COMPARISON_OPTIONS,
  readComparisonOptions,
} from "@/server/comparison";
import { mapProcessingJob } from "@/server/processing/jobs";
import { isConfirmedAnalysisStart } from "@/lib/analysis-start";
function workerUrl(request: Request) {
  const base =
    process.env.APP_BASE_URL ||
    process.env.URL ||
    (process.env.NODE_ENV !== "production" ? new URL(request.url).origin : "");
  if (!base) throw new ApiError("APP_BASE_URL is not configured.", 500);
  return new URL(
    "/.netlify/functions/process-case-background",
    base,
  ).toString();
}
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    await ownedCase(db, user, id);
    const body = await jsonBody(request);
    const analysisMode =
      body.analysisMode === "smart_split" ? "smart_split" : "standard";
    const comparisonOptions = readComparisonOptions(
      body.comparisonOptions ?? DEFAULT_COMPARISON_OPTIONS,
    );
    const secret = process.env.WORKER_SECRET;
    if (!secret) throw new ApiError("WORKER_SECRET is not configured.", 500);
    if (!process.env.OPENROUTER_API_KEY)
      throw new ApiError("OPENROUTER_API_KEY is not configured.", 500);
    const { data, error } = await db.rpc("enqueue_case_analysis", {
      p_user: user,
      p_case: uuid(id),
      p_options: { analysisMode, comparisonOptions },
    });
    dbCheck(error);
    if (!isConfirmedAnalysisStart(data)) {
      throw new ApiError(
        "Analysis did not start. The case is still safe in Draft; please retry.",
        503,
      );
    }
    // The on-prem/local stack runs a persistent queue worker beside Next.js.
    // Returning immediately avoids the Netlify background-function cold start
    // while preserving the same database claim/lease/retry guarantees.
    if (process.env.LOCAL_CASE_WORKER !== "true") {
      const target = workerUrl(request);
      const dispatched = await fetch(target, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          "Content-Type": "application/json",
          "X-Worker-Secret": secret,
        },
        body: JSON.stringify({ jobId: data.job.id }),
      }).catch(() => null);
      if (!dispatched?.ok)
        console.warn(
          "Case queued; background dispatch will retry",
          data.job.id,
          dispatched?.status,
        );
    }
    return { case: mapCase(data.case), job: mapProcessingJob(data.job) };
  });
}
