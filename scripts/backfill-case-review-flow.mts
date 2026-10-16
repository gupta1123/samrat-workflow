// Queues a fresh SAP match for cases the migration backfill could not classify
// (no finished match, or an old result). The worker saves review_flow itself.
// Dry run by default:  tsx scripts/backfill-case-review-flow.mts [--run] [--limit=50]
import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const { createSupabaseAdminClient } =
  await import("../src/server/supabase/admin");
const { enqueueSapMatch } = await import("../src/server/sap/match-job");

const run = process.argv.includes("--run");
const limit = Number(
  process.argv.find((arg) => arg.startsWith("--limit="))?.slice(8) ?? 50,
);
const db = createSupabaseAdminClient();
const { data, error } = await db
  .from("packet_cases")
  .select("id,owner_user_id,display_name")
  .is("deleted_at", null)
  .is("review_flow", null)
  .order("created_at", { ascending: false })
  .limit(limit);
if (error) throw error;
console.log(
  `${data.length} unclassified case(s)${run ? "" : " (dry run, pass --run)"}`,
);
for (const row of data) {
  console.log(row.id, row.display_name);
  if (run) await enqueueSapMatch(db, row.owner_user_id, row.id);
}
