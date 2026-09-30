import { randomUUID } from "node:crypto";

import { dbCheck } from "@/server/api/helpers";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { computeCaseMatch, type CaseMatch } from "./match-data";
import { withTestServiceLayer } from "./service-layer";

export type SapMatchJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type SapMatchJobRow = {
  case_id: string;
  owner_user_id: string;
  version: number;
  status: SapMatchJobStatus;
  stage: string;
  result: CaseMatch | null;
  error: string | null;
  attempt_count: number;
  requested_at: string;
  finished_at: string | null;
  updated_at: string;
};

type Db = ReturnType<typeof createSupabaseAdminClient>;

export async function enqueueSapMatch(
  db: Db,
  userId: string,
  caseId: string,
  force = false,
) {
  const { data, error } = await db.rpc("enqueue_sap_match", {
    p_user: userId,
    p_case: caseId,
    p_force: force,
  });
  dbCheck(error);
  return data as unknown as SapMatchJobRow;
}

export async function readSapMatchJob(db: Db, userId: string, caseId: string) {
  const { data, error } = await db
    .from("sap_match_jobs")
    .select(
      "case_id,owner_user_id,version,status,stage,result,error,attempt_count,requested_at,finished_at,updated_at",
    )
    .eq("case_id", caseId)
    .eq("owner_user_id", userId)
    .maybeSingle();
  dbCheck(error);
  return data as unknown as SapMatchJobRow | null;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "SAP matching failed.");
}

/** Claims and executes one durable SAP match job. Called only by the Heroku worker. */
export async function processSapMatchJob(caseId: string) {
  const db = createSupabaseAdminClient();
  const worker = `sap-${process.pid}-${randomUUID()}`;
  const claimed = await db.rpc("claim_sap_match_job", {
    p_case: caseId,
    p_worker: worker,
  });
  dbCheck(claimed.error);
  const job = claimed.data as unknown as SapMatchJobRow | null;
  if (!job) return { skipped: true as const };

  try {
    const row = await db
      .from("packet_cases")
      .select("id,owner_user_id,invoice_number,po_number,status")
      .eq("id", caseId)
      .eq("owner_user_id", job.owner_user_id)
      .is("deleted_at", null)
      .maybeSingle();
    dbCheck(row.error);
    if (!row.data) throw new Error("Case no longer exists.");

    const result = await withTestServiceLayer((client) =>
      computeCaseMatch({ db, client, caseRow: row.data! }),
    );
    const complete = await db.rpc("complete_sap_match_job", {
      p_case: caseId,
      p_version: job.version,
      p_worker: worker,
      p_result: result,
    });
    dbCheck(complete.error);
    return { skipped: false as const, result };
  } catch (error) {
    const detail = message(error);
    const terminal = /not configured|no numbered vendor invoice|no invoice line items/i.test(detail);
    const failed = await db.rpc("fail_sap_match_job", {
      p_case: caseId,
      p_version: job.version,
      p_worker: worker,
      p_error: detail,
      p_retry: !terminal,
    });
    dbCheck(failed.error);
    throw error;
  }
}
