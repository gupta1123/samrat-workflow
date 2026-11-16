import { ApiError, dbCheck, uuid } from "@/server/api/helpers";
import { DEFAULT_COMPARISON_OPTIONS } from "@/server/comparison";
import { isConfirmedAnalysisStart } from "@/lib/analysis-start";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";

type Db = ReturnType<typeof createSupabaseAdminClient>;

export type AutomaticIntake = {
  owner: string;
  fromDate: string;
  fromInstant: string;
};

export function readAutomaticIntake(): AutomaticIntake | null {
  if (process.env.AUTOMATIC_INTAKE_ENABLED !== "true") return null;
  const fromDate = process.env.AUTOMATIC_INTAKE_FROM?.trim() ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate))
    throw new Error("AUTOMATIC_INTAKE_FROM must be a date (YYYY-MM-DD).");
  const start = new Date(`${fromDate}T00:00:00Z`);
  if (
    Number.isNaN(start.getTime()) ||
    start.toISOString().slice(0, 10) !== fromDate
  )
    throw new Error("AUTOMATIC_INTAKE_FROM is not a valid date.");
  return {
    owner: uuid(process.env.AUTOMATIC_INTAKE_OWNER?.trim()),
    fromDate,
    fromInstant: new Date(`${fromDate}T00:00:00+05:30`).toISOString(),
  };
}

export async function analysisQueueIsIdle(db: Db) {
  const [analysis, matching] = await Promise.all([
    db
      .from("packet_processing_jobs")
      .select("id")
      .in("status", ["queued", "running"])
      .limit(1),
    db
      .from("sap_match_jobs")
      .select("case_id")
      .in("status", ["queued", "running"])
      .limit(1),
  ]);
  dbCheck(analysis.error);
  dbCheck(matching.error);
  return !analysis.data?.length && !matching.data?.length;
}

export async function queueIntakeAnalysis(
  db: Db,
  user: string,
  caseId: string,
  automatic: boolean,
) {
  if (!process.env.OPENROUTER_API_KEY)
    throw new ApiError(
      "Invoice analysis is unavailable. Try again later.",
      503,
    );
  if (automatic && !(await analysisQueueIsIdle(db))) return null;

  const result = await db.rpc("enqueue_case_analysis", {
    p_user: user,
    p_case: caseId,
    p_options: {
      analysisMode: "standard",
      comparisonOptions: DEFAULT_COMPARISON_OPTIONS,
      ...(automatic ? { automaticIntake: true } : {}),
    },
  });
  dbCheck(result.error);
  if (!isConfirmedAnalysisStart(result.data))
    throw new Error("Analysis queue did not confirm the case.");
  return result.data.job.id as string;
}
