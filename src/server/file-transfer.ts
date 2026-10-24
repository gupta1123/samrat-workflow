import { randomUUID } from "node:crypto";
import { ApiError, withUser } from "./api/helpers";
import { createSupabaseAdminClient } from "./supabase/admin";
import { TRANSFER_ID_HEADER } from "@/lib/file-transfer";

export type TransferDb = ReturnType<typeof createSupabaseAdminClient>;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function fileTransferRequest(
  request: Request,
  operation: string,
  fn: (db: TransferDb, user: string) => Promise<unknown>,
) {
  const supplied = request.headers.get(TRANSFER_ID_HEADER) || "";
  const requestId = UUID.test(supplied) ? supplied : randomUUID();
  const started = Date.now();
  const response = await withUser(request, async (_db, user) => {
    try {
      return await fn(
        createSupabaseAdminClient({ fetchTimeoutMs: 45_000 }),
        user,
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        "File storage is temporarily unavailable. Please retry.",
        503,
        { code: "storage_unavailable" },
      );
    }
  });
  response.headers.set(TRANSFER_ID_HEADER, requestId);
  response.headers.set("Cache-Control", "private, no-store");
  const event = {
    scope: "file-transfer",
    requestId,
    operation,
    status: response.status,
    durationMs: Date.now() - started,
  };
  (response.status >= 400 ? console.warn : console.info)(JSON.stringify(event));
  return response;
}

export function transferDiagnostic(body: Record<string, unknown>) {
  if (typeof body.requestId !== "string" || !UUID.test(body.requestId))
    throw new ApiError("Invalid transfer reference.");
  if (
    !["prepare", "status", "part", "complete", "metadata", "download"].includes(
      String(body.operation),
    )
  )
    throw new ApiError("Invalid transfer operation.");
  if (!["timeout", "network", "http"].includes(String(body.failure)))
    throw new ApiError("Invalid failure category.");
  return {
    scope: "file-transfer-client",
    requestId: body.requestId,
    operation: body.operation,
    failure: body.failure,
    status:
      Number.isInteger(body.status) &&
      Number(body.status) >= 0 &&
      Number(body.status) <= 599
        ? Number(body.status)
        : 0,
    durationMs: Math.min(300_000, Math.max(0, Number(body.durationMs) || 0)),
  };
}
