import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");
const output = execFileSync(
  "./node_modules/.bin/supabase",
  ["status", "--output", "json"],
  {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" },
  },
);
const local = JSON.parse(output.slice(output.indexOf("{")));
process.env.NEXT_PUBLIC_SUPABASE_URL = local.API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = local.SECRET_KEY;
const { createSupabaseAdminClient } =
  await import("../src/server/supabase/admin.ts");
const { createReviewCheckpointStore, reviewCheckpointKey } =
  await import("../src/server/processing/review-checkpoints.ts");
const db = createSupabaseAdminClient();
const testCaseId = randomUUID();
let leaseChecks = 0;
const checkpoint = createReviewCheckpointStore(db, testCaseId, async () => {
  leaseChecks++;
});
const key = reviewCheckpointKey("source", { syntheticSmokeTest: true });
try {
  assert.equal(await checkpoint.store.read(key), null);
  await checkpoint.store.write(key, '{"syntheticSmokeTest":true}');
  assert.equal(await checkpoint.store.read(key), '{"syntheticSmokeTest":true}');
  const { createClient } = await import("@supabase/supabase-js");
  const anonymous = createClient(local.API_URL, local.PUBLISHABLE_KEY, {
    auth: { persistSession: false },
  });
  const path = `_review_checkpoints/${testCaseId}/${key}.json.gz`;
  const denied = await anonymous.storage.from("packet-files").download(path);
  assert.ok(
    denied.error,
    "An anonymous client must not download internal review evidence.",
  );
  const asset = await db
    .from("storage_assets")
    .select("id")
    .eq("storage_path", path);
  assert.equal(asset.error, null);
  assert.equal(asset.data?.length, 0);
  assert.ok(leaseChecks >= 4);
  await checkpoint.clearUsed();
  assert.equal(await checkpoint.store.read(key), null);
  console.log(
    "Private checkpoint round-trip, anonymous-access denial, missing-object handling and exact temporary-object removal passed. No case data or AI requests used.",
  );
} finally {
  await checkpoint.clearUsed();
}
