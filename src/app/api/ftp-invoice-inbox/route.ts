import { ApiError, jsonBody, uuid, withUser } from "@/server/api/helpers";
import { readSapEnvironment } from "@/server/sap/config";
import { UPLOAD_LIMITS } from "@/server/uploads";
import {
  canAnalyzeInvoice,
  checkInboxError,
  INBOX_PAGE_SIZE,
  type FtpInvoiceRow,
} from "@/server/ftp-inbox/data";
import type { FtpInvoicePage } from "@/lib/ftp-invoice-inbox";

function requireProduction() {
  if (readSapEnvironment() !== "live")
    throw new ApiError("The invoice inbox is available in Production.", 409);
}

export async function GET(request: Request) {
  return withUser(request, async (db, user) => {
    requireProduction();
    const params = new URL(request.url).searchParams;
    const page = Number(params.get("page") ?? 1);
    const search = (params.get("q") ?? "").trim().slice(0, 100);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000)
      throw new ApiError("Choose a valid page.");
    const first = (page - 1) * INBOX_PAGE_SIZE;
    let query = db
      .from("ftp_invoice_inbox")
      .select("*", { count: "exact" })
      .neq("status", "missing");
    if (search)
      query = query.ilike(
        "file_name",
        `%${search.replace(/[\\%_*]/g, "\\$&")}%`,
      );
    const [inbox, sync] = await Promise.all([
      query
        .order("discovered_at", { ascending: false })
        .order("id")
        .range(first, first + INBOX_PAGE_SIZE - 1),
      db
        .from("ftp_invoice_sync")
        .select("last_success_at,error")
        .eq("id", 1)
        .single(),
    ]);
    checkInboxError(inbox.error);
    checkInboxError(sync.error);
    return {
      rows: ((inbox.data ?? []) as FtpInvoiceRow[]).map((row) => ({
        id: row.id,
        fileName: row.file_name,
        discoveredAt: row.discovered_at,
        status: row.status,
        caseId: row.owner_user_id === user ? row.case_id : null,
        error: row.error,
        canAnalyze:
          row.size_bytes <= UPLOAD_LIMITS.bytes && canAnalyzeInvoice(row, user),
      })),
      page,
      totalPages: Math.max(1, Math.ceil((inbox.count ?? 0) / INBOX_PAGE_SIZE)),
      lastSuccessAt: sync.data?.last_success_at ?? null,
      connectionError: sync.data?.error ?? null,
    } satisfies FtpInvoicePage;
  });
}

export async function POST(request: Request) {
  return withUser(request, async (db, user) => {
    requireProduction();
    const id = uuid((await jsonBody(request))?.id);
    const lookup = await db
      .from("ftp_invoice_inbox")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    checkInboxError(lookup.error);
    const row = lookup.data as FtpInvoiceRow | null;
    if (!row) throw new ApiError("Invoice file not found.", 404);
    if (!canAnalyzeInvoice(row, user) || row.size_bytes > UPLOAD_LIMITS.bytes)
      throw new ApiError(
        "This file is no longer ready to analyze. Refresh the inbox.",
        409,
      );
    const queued = await db
      .from("ftp_invoice_inbox")
      .update({
        status: "queued",
        owner_user_id: user,
        requested_at: new Date().toISOString(),
        error: null,
      })
      .eq("id", id)
      .eq("status", row.status)
      .or(`owner_user_id.is.null,owner_user_id.eq.${user}`)
      .or("present.eq.true,case_id.not.is.null")
      .select("id")
      .maybeSingle();
    checkInboxError(queued.error);
    if (!queued.data)
      throw new ApiError(
        "Someone already updated this file. Refresh the inbox.",
        409,
      );
    return { queued: true };
  });
}
