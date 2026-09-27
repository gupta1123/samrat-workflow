// Fully local preview with synthetic data. Never used by build/start or Netlify.
import { spawn } from "node:child_process";
const common = { cwd: process.cwd(), stdio: "inherit" };
const fixtures = spawn(
  process.execPath,
  ["--import", "tsx", "tests/preview-server.mts"],
  common,
);
const web = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--port",
    "3067",
    "--hostname",
    "127.0.0.1",
  ],
  {
    ...common,
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54329",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "preview-publishable-only",
      SUPABASE_SERVICE_ROLE_KEY: "preview-service-only",
      APP_BASE_URL: "http://127.0.0.1:54329",
      WORKER_SECRET: "preview-worker-only",
      OPENROUTER_API_KEY: "preview-disabled",
      NEXT_PUBLIC_DEMO_MODE: "true",
      SAMRAT_NEXT_DIST_DIR: ".next-preview",
    },
  },
);
console.log(
  "LOCAL PREVIEW: http://127.0.0.1:3067 — reviewer@example.invalid / local-fixture-only",
);
const stop = () => {
  fixtures.kill();
  web.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
fixtures.on("exit", () => web.kill());
web.on("exit", () => fixtures.kill());
