import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const output = execFileSync(
  "./node_modules/.bin/supabase",
  ["status", "--output", "json"],
  {
    encoding: "utf8",
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const jsonStart = output.indexOf("{");
if (jsonStart < 0) throw new Error("Local Supabase status returned no JSON.");
const local = JSON.parse(output.slice(jsonStart));
const client = createClient(local.API_URL, local.SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const tables = [
  "packet_cases",
  "storage_assets",
  "packet_case_files",
  "packet_documents",
  "packet_mismatches",
  "packet_processing_jobs",
  "case_review_events",
  "field_settings",
  "doc_type_settings",
  "comparison_field_groups",
];

for (const table of tables) {
  const { error } = await client.from(table).select("*").limit(1);
  if (error) throw new Error(`${table}: ${error.message}`);
}

const { data: buckets, error: bucketError } =
  await client.storage.listBuckets();
if (bucketError) throw bucketError;
const packetBucket = buckets.find((bucket) => bucket.id === "packet-files");
if (!packetBucket) throw new Error("The packet-files bucket is missing.");
if (packetBucket.public)
  throw new Error("The packet-files bucket must remain private.");

const { data: authData, error: authError } = await client.auth.admin.listUsers({
  page: 1,
  perPage: 100,
});
if (authError) throw authError;

console.log(
  JSON.stringify(
    {
      api: local.API_URL,
      studio: local.STUDIO_URL,
      tables: `${tables.length}/${tables.length}`,
      storage: "packet-files is private",
      authAdmin: "available",
      authUsers: authData.users.length,
    },
    null,
    2,
  ),
);
