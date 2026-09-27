import fs from "node:fs";
import net from "node:net";
import { execFileSync, spawn, spawnSync } from "node:child_process";

if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");

const supabaseBinary = "./node_modules/.bin/supabase";
const cliEnvironment = {
  ...process.env,
  SUPABASE_TELEMETRY_DISABLED: "1",
};

function readLocalStatus() {
  const output = execFileSync(supabaseBinary, ["status", "--output", "json"], {
    encoding: "utf8",
    env: cliEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const jsonStart = output.indexOf("{");
  if (jsonStart < 0) throw new Error("Supabase status returned no JSON.");
  return JSON.parse(output.slice(jsonStart));
}

let local;
try {
  local = readLocalStatus();
} catch {
  console.log("Local Supabase is stopped. Starting it now…");
  const started = spawnSync(supabaseBinary, ["start"], {
    env: cliEnvironment,
    stdio: "inherit",
  });
  if (started.status !== 0) process.exit(started.status || 1);
  local = readLocalStatus();
}

const applicationEnvironment = {
  ...process.env,
  NEXT_PUBLIC_SUPABASE_URL: local.API_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: local.PUBLISHABLE_KEY,
  SUPABASE_SERVICE_ROLE_KEY: local.SECRET_KEY,
  APP_BASE_URL: "http://localhost:8888",
  LOCAL_CASE_WORKER: "true",
};

function portIsAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

async function findFrameworkPort() {
  for (let port = 3000; port < 3100; port += 1) {
    if (await portIsAvailable(port)) return port;
  }
  throw new Error("No available local framework port was found.");
}

const frameworkPort = await findFrameworkPort();

console.log(`Local Supabase API: ${local.API_URL}`);
console.log(`Local Supabase Studio: ${local.STUDIO_URL}`);
console.log("Starting Samrat at http://localhost:8888 …");

const web = spawn(
  "netlify",
  [
    "dev",
    "--target-port",
    String(frameworkPort),
    "--command",
    `npm run dev -- --port ${frameworkPort}`,
  ],
  {
  stdio: "inherit",
  env: applicationEnvironment,
  },
);

const worker = spawn(
  "./node_modules/.bin/tsx",
  ["watch", "scripts/local-case-worker.ts"],
  {
    stdio: "inherit",
    env: applicationEnvironment,
  },
);

let shuttingDown = false;

function stop(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  web.kill(signal);
  worker.kill(signal);
}

web.on("error", () => {
  console.error("Install Netlify CLI first: npm install -g netlify-cli");
  process.exitCode = 1;
});
worker.on("error", (error) => {
  console.error("Unable to start the local case worker:", error.message);
  stop("SIGTERM");
  process.exitCode = 1;
});
web.on("exit", (code) => {
  if (!shuttingDown) worker.kill("SIGTERM");
  process.exitCode = code || 0;
});
worker.on("exit", (code) => {
  if (!shuttingDown && code) {
    console.error(`Local case worker stopped unexpectedly (${code}).`);
    web.kill("SIGTERM");
    process.exitCode = code;
  }
});
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
