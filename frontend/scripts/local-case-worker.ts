import { processCaseJob } from "../src/server/process-job";
import { createSupabaseAdminClient } from "../src/server/supabase/admin";

const IDLE_POLL_MS = 400;
const RECOVERY_INTERVAL_MS = 15 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let stopping = false;
let lastRecoveryAt = 0;
let lastCleanupAt = 0;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function nextQueuedJobId() {
  const db = createSupabaseAdminClient();
  const { data, error } = await db
    .from("packet_processing_jobs")
    .select("id")
    .eq("status", "queued")
    .lte("next_run_at", new Date().toISOString())
    .order("next_run_at", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return typeof data?.id === "string" ? data.id : null;
}

async function recoverStaleJobs() {
  const db = createSupabaseAdminClient();
  const { error } = await db.rpc("recover_stale_case_jobs");
  if (error) throw error;
  lastRecoveryAt = Date.now();
}

async function cleanupOrphanUploads() {
  const db = createSupabaseAdminClient();
  const { data, error } = await db.rpc("orphan_uploads");
  if (error) throw error;

  const assets = (data ?? []) as { id: string; storage_path: string }[];
  if (assets.length) {
    const removed = await db.storage
      .from("packet-files")
      .remove(assets.map((asset) => asset.storage_path));
    if (removed.error) throw removed.error;

    const deleted = await db
      .from("storage_assets")
      .delete()
      .in(
        "id",
        assets.map((asset) => asset.id),
      );
    if (deleted.error) throw deleted.error;
  }

  lastCleanupAt = Date.now();
}

async function runMaintenanceIfDue() {
  const now = Date.now();
  if (now - lastRecoveryAt >= RECOVERY_INTERVAL_MS) {
    await recoverStaleJobs();
  }
  if (now - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
    await cleanupOrphanUploads();
  }
}

async function run() {
  console.log("Local case worker ready.");

  while (!stopping) {
    try {
      await runMaintenanceIfDue();
      const jobId = await nextQueuedJobId();
      if (!jobId) {
        await wait(IDLE_POLL_MS);
        continue;
      }

      const startedAt = Date.now();
      console.log(`[case-worker] processing ${jobId}`);
      const result = await processCaseJob(jobId);
      if (result?.skipped) {
        // Another worker may have claimed it, or the database's queue clock
        // may not yet consider it due. A skipped claim is not a completion.
        await wait(IDLE_POLL_MS);
        continue;
      }
      console.log(
        `[case-worker] completed ${jobId} in ${Date.now() - startedAt}ms`,
      );
    } catch (error) {
      console.error(
        "[case-worker] processing failed:",
        error instanceof Error ? error.message : error,
      );
      await wait(1000);
    }
  }
}

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

void run().catch((error) => {
  console.error("Local case worker stopped:", error);
  process.exitCode = 1;
});
