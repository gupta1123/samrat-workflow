import { randomUUID } from "node:crypto";

import { dbCheck } from "@/server/api/helpers";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { evaluateMatch } from "@/lib/sap-match/engine";
import { reviewFlowOf } from "@/lib/sap-match/review-flow";
import { computeCaseMatch, loadMatchState, type CaseMatch } from "./match-data";
import { withTestServiceLayer } from "./service-layer";

export type SapMatchJobStatus =
  "queued" | "running" | "succeeded" | "failed" | "cancelled";

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

/** Postgres jsonb rejects U+0000, which SAP free-text fields can contain. */
export function stripNul<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === "string" ? item.replace(/\u0000/g, "") : item,
    ),
  ) as T;
}

/** Supabase errors are plain objects, so `String(error)` would be "[object Object]". */
export function jobErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const { message, code, details, hint } = error as Record<string, unknown>;
    const text = [message, details, hint]
      .filter((part): part is string => typeof part === "string" && !!part)
      .join(" · ");
    if (text) return code ? `${text} (${String(code)})` : text;
    try {
      return JSON.stringify(error).slice(0, 500);
    } catch {
      return "SAP matching failed.";
    }
  }
  return String(error ?? "SAP matching failed.");
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
      .select(
        "id,owner_user_id,invoice_number,po_number,status,processing_meta",
      )
      .eq("id", caseId)
      .eq("owner_user_id", job.owner_user_id)
      .is("deleted_at", null)
      .maybeSingle();
    dbCheck(row.error);
    if (!row.data) throw new Error("Case no longer exists.");

    const result = await withTestServiceLayer((client) =>
      computeCaseMatch({ db, client, caseRow: row.data! }),
    );
    if ("timings" in result && result.timings)
      console.info("SAP match timings", { caseId, timings: result.timings });
    const complete = await db.rpc("complete_sap_match_job", {
      p_case: caseId,
      p_version: job.version,
      p_worker: worker,
      p_result: stripNul(result),
    });
    dbCheck(complete.error);
    await saveCaseClassification(db, caseId, result);
    return { skipped: false as const, result };
  } catch (error) {
    const detail = jobErrorMessage(error);
    const terminal =
      /not configured|no numbered vendor invoice|no invoice line items/i.test(
        detail,
      );
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

/** A snapshot older than this is re-read from SAP instead of reused. */
/**
 * Stores how the case is reviewed (packet_cases.review_flow / supply_kind).
 * Best effort: a failure here, or columns not migrated yet, never fails a match.
 */
async function saveCaseClassification(
  db: Db,
  caseId: string,
  match: CaseMatch,
) {
  if (!match.available) return;
  try {
    const { error } = await db
      .from("packet_cases")
      .update({
        review_flow: reviewFlowOf(match.result),
        supply_kind: match.invoice.supplyNature ?? "unknown",
      })
      .eq("id", caseId);
    if (error)
      console.warn("Case classification not saved", {
        caseId,
        error: error.message,
      });
  } catch (error) {
    console.warn("Case classification not saved", { caseId, error });
  }
}

export const SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Re-evaluates the stored SAP read with the reviewer's latest choices. Returns
 * false when there is no usable snapshot, so the caller queues a full re-read.
 */
export async function recomputeFromSnapshot(
  db: Db,
  userId: string,
  caseId: string,
  now = Date.now(),
) {
  const job = await readSapMatchJob(db, userId, caseId);
  const match = job?.result;
  if (!job || job.status !== "succeeded" || !match?.available || !match.context)
    return false;
  const readAt = Date.parse(match.context.checkedAt ?? "");
  if (!Number.isFinite(readAt) || now - readAt > SNAPSHOT_MAX_AGE_MS)
    return false;
  const started = Date.now();
  const state = await loadMatchState(db, caseId);
  const result = evaluateMatch({
    invoice: match.invoice,
    context: match.context,
    rules: match.rules,
    state,
  });
  const next: CaseMatch = {
    ...match,
    state,
    result,
    timings: [
      { step: "recomputed from saved SAP read", ms: Date.now() - started },
    ],
  };
  const { data, error } = await db
    .from("sap_match_jobs")
    .update({ result: stripNul(next), error: null })
    .eq("case_id", caseId)
    .eq("version", job.version)
    .eq("status", "succeeded")
    .select("case_id");
  dbCheck(error);
  const saved = (data ?? []).length === 1;
  if (saved) await saveCaseClassification(db, caseId, next);
  return saved;
}
