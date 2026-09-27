import type { Config } from "@netlify/functions";
import { processCaseJob } from "../../src/server/process-job";

// Keep the legacy -background filename and declare the current explicit mode so
// deployment configuration cannot accidentally turn this into a short request.
export const config: Config = { background: true };

export default async function handler(request: Request) {
  if (
    !process.env.WORKER_SECRET ||
    request.headers.get("x-worker-secret") !== process.env.WORKER_SECRET
  )
    return new Response("Unauthorized", { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { jobId?: string };
  if (!body.jobId) return new Response("Missing jobId", { status: 400 });
  await processCaseJob(body.jobId);
  return new Response(null, { status: 204 });
}
