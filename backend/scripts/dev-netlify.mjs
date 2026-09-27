import fs from "node:fs";
import { spawn } from "node:child_process";
if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");
// Export the same local configuration to Next.js AND Netlify background functions.
const child = spawn("netlify", ["dev"], { stdio: "inherit", env: process.env });
child.on("error", () => {
  console.error("Install Netlify CLI first: npm install -g netlify-cli");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code || 0;
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
