import type { Config } from "@netlify/functions";
import { createSupabaseAdminClient } from "../../src/server/supabase/admin";
export const config: Config = { schedule: "17 2 * * *" };
export default async function handler() {
  // The Heroku worker dyno owns orphan cleanup in production. Leave this
  // scheduled function active only where no external worker runs.
  if (process.env.DISABLE_NETLIFY_SCHEDULES === "true") return;
  const db = createSupabaseAdminClient();
  const { data, error } = await db.rpc("orphan_uploads");
  if (error) throw error;
  const assets = (data || []) as { id: string; storage_path: string }[];
  if (!assets.length) return;
  const removed = await db.storage
    .from("packet-files")
    .remove(assets.map((a) => a.storage_path));
  if (removed.error) throw removed.error;
  const deleted = await db
    .from("storage_assets")
    .delete()
    .in(
      "id",
      assets.map((a) => a.id),
    );
  if (deleted.error) throw deleted.error;
}
