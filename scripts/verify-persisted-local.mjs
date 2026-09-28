import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");

const caseId = process.argv[2];
if (!caseId) {
  console.error("Usage: npm run verify:persisted:local -- CASE_ID");
  process.exit(1);
}

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
if (jsonStart < 0) throw new Error("Supabase status returned no JSON.");
const local = JSON.parse(output.slice(jsonStart));

const result = spawnSync(
  "./node_modules/.bin/tsx",
  ["scripts/verify-persisted-case.ts", caseId],
  {
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: local.API_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: local.PUBLISHABLE_KEY,
      SUPABASE_SERVICE_ROLE_KEY: local.SECRET_KEY,
    },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
