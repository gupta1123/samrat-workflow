import type { Config } from "@netlify/functions";
import { createSupabaseAdminClient } from "../../src/server/supabase/admin";
export const config: Config = { schedule: "* * * * *" };
export default async function handler() {
  // The Heroku worker dyno owns job recovery in production. Leave this
  // scheduled function active only where no external worker runs.
  if (process.env.DISABLE_NETLIFY_SCHEDULES === "true") return;
  const db = createSupabaseAdminClient();
  const recovered = await db.rpc("recover_stale_case_jobs");
  if (recovered.error) throw recovered.error;
  const { data, error } = await db
    .from("packet_processing_jobs")
    .select("id")
    .eq("status", "queued")
    .lte("next_run_at", new Date().toISOString())
    .order("created_at")
    .limit(3);
  if (error) throw error;
  const base = process.env.APP_BASE_URL || process.env.URL;
  const secret = process.env.WORKER_SECRET;
  if (!base || !secret)
    throw new Error("APP_BASE_URL/WORKER_SECRET is missing");
  await Promise.all(
    (data || []).map((j) =>
      fetch(new URL("/.netlify/functions/process-case-background", base), {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          "Content-Type": "application/json",
          "X-Worker-Secret": secret,
        },
        body: JSON.stringify({ jobId: j.id }),
      }).then((response) => {
        if (!response.ok)
          throw new Error(`Background dispatch failed (${response.status})`);
      }),
    ),
  );
}
