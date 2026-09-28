import fs from "node:fs";
if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");
const required = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENROUTER_API_KEY",
  "WORKER_SECRET",
];
let failed = false;
for (const name of required) {
  const ready = Boolean(process.env[name]?.trim());
  console.log(`${ready ? "OK" : "MISSING"}  ${name}`);
  if (!ready) failed = true;
}
if (process.env.WORKER_SECRET && process.env.WORKER_SECRET.length < 32) {
  console.log("ERROR  WORKER_SECRET needs at least 32 characters.");
  failed = true;
}
if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") {
  console.log(
    "ERROR  Remove NEXT_PUBLIC_DEMO_MODE before using real data or deploying.",
  );
  failed = true;
}
if (
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.startsWith("sb_secret_")
) {
  console.log(
    "ERROR  A secret key was placed in a public variable. Move it to SUPABASE_SERVICE_ROLE_KEY and rotate the exposed secret.",
  );
  failed = true;
}
try {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL || "");
  if (
    url.protocol !== "https:" &&
    !["127.0.0.1", "localhost"].includes(url.hostname)
  )
    throw new Error();
} catch {
  console.log("ERROR  Set a valid Supabase project URL.");
  failed = true;
}
console.log(
  failed
    ? "Setup is incomplete. Follow SETUP.md."
    : "Configuration is present. This check does not validate credentials or database connectivity.",
);
process.exitCode = failed ? 1 : 0;
