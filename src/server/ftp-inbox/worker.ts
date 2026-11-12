import { createHash, randomUUID } from "node:crypto";
import { ApiError, dbCheck } from "@/server/api/helpers";
import { DEFAULT_COMPARISON_OPTIONS } from "@/server/comparison";
import { storeImportedPdf } from "@/server/imported-pdf";
import {
  readSapEnvironment,
  sapCaseEnvironment,
  sapCaseOrigin,
} from "@/server/sap/config";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { UPLOAD_LIMITS } from "@/server/uploads";
import { isConfirmedAnalysisStart } from "@/lib/analysis-start";
import { checkInboxError, SCAN_INTERVAL_MS, type FtpInvoiceRow } from "./data";
import {
  archiveFilename,
  createInvoiceFtp,
  InboxFtpError,
  sameRemoteFile,
  type InvoiceFtp,
  type RemoteInvoice,
} from "./transport";

type Db = ReturnType<typeof createSupabaseAdminClient>;
type CaseJob = { id: string; status: string; created_at: string };
const table = "ftp_invoice_inbox";
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

function remoteInvoice(row: FtpInvoiceRow): RemoteInvoice {
  return {
    name: row.file_name,
    size: row.size_bytes,
    modifiedAt: row.modified_at,
  };
}

async function update(
  db: Db,
  id: string,
  fields: Partial<FtpInvoiceRow>,
  status?: FtpInvoiceRow["status"],
) {
  let query = db.from(table).update(fields).eq("id", id);
  if (status) query = query.eq("status", status);
  const result = await query;
  dbCheck(result.error);
}

export async function discoverInvoices(db: Db, entries: RemoteInvoice[]) {
  const observed = new Map(entries.map((entry) => [entry.name, entry]));
  if (observed.size !== entries.length)
    throw new InboxFtpError("The FTP inbox returned duplicate file names.");

  // Read the complete active set before changing it, so pagination stays stable.
  const current: FtpInvoiceRow[] = [];
  for (let offset = 0; ; offset += 500) {
    const result = await db
      .from(table)
      .select("*")
      .eq("present", true)
      .order("id")
      .range(offset, offset + 499);
    dbCheck(result.error);
    const page = (result.data ?? []) as FtpInvoiceRow[];
    current.push(...page);
    if (page.length < 500) break;
  }
  for (const row of current) {
    const entry = observed.get(row.file_name);
    if (!entry || !sameRemoteFile(remoteInvoice(row), entry)) {
      // Keep the case history if the client removes or replaces its FTP source.
      await update(db, row.id, { present: false });
      const retired = await db
        .from(table)
        .update({ status: "missing" })
        .eq("id", row.id)
        .is("case_id", null)
        .in("status", ["copying", "ready", "queued", "failed"]);
      dbCheck(retired.error);
      continue;
    }
    observed.delete(row.file_name);
    if (row.status === "copying" && entry.size > 0) {
      await update(
        db,
        row.id,
        entry.size <= UPLOAD_LIMITS.bytes
          ? { status: "ready" }
          : {
              status: "failed",
              error: "This PDF is over the 50 MB upload limit.",
            },
        "copying",
      );
    }
  }
  const newRows = [...observed.values()].map((entry) => ({
    file_name: entry.name,
    size_bytes: entry.size,
    modified_at: entry.modifiedAt,
  }));
  if (newRows.length) {
    const result = await db.from(table).insert(newRows);
    dbCheck(result.error);
  }
}

async function latestJob(db: Db, caseId: string) {
  const result = await db
    .from("packet_processing_jobs")
    .select("id,status,created_at")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  dbCheck(result.error);
  return result.data as CaseJob | null;
}

async function duplicateCase(db: Db, hash: string, user: string) {
  const prior = await db
    .from(table)
    .select("case_id,owner_user_id")
    .eq("sha256", hash)
    .not("case_id", "is", null)
    .limit(20);
  dbCheck(prior.error);
  const candidateIds = (prior.data ?? []).map((row) => row.case_id);
  const matching = await db
    .from("packet_case_files")
    .select(
      "case_id,packet_cases!inner(owner_user_id,created_at,processing_meta,deleted_at)",
    )
    .eq("content_sha256", hash)
    .is("packet_cases.deleted_at", null)
    .order("case_id")
    .limit(100);
  dbCheck(matching.error);
  for (const item of matching.data ?? []) {
    const relation: unknown = item.packet_cases;
    const row = (Array.isArray(relation) ? relation[0] : relation) as {
      owner_user_id: string;
      created_at: string;
      processing_meta: unknown;
    } | null;
    if (
      !row ||
      (row.owner_user_id !== user && !candidateIds.includes(item.case_id))
    )
      continue;
    if (
      sapCaseEnvironment(sapCaseOrigin(row.created_at, row.processing_meta)) ===
      "live"
    )
      return { caseId: item.case_id as string, owner: row.owner_user_id };
  }
  return null;
}

async function importPdf(
  db: Db,
  ftp: InvoiceFtp,
  row: FtpInvoiceRow,
  owner: string,
) {
  const before = (await ftp.list("in")).find(
    (item) => item.name === row.file_name,
  );
  if (!before || !sameRemoteFile(remoteInvoice(row), before))
    throw new ApiError(
      "The source PDF changed or was removed. Wait for the inbox to refresh.",
      409,
    );
  const bytes = await ftp.download("in", row.file_name);
  const after = (await ftp.list("in")).find(
    (item) => item.name === row.file_name,
  );
  if (
    !after ||
    !sameRemoteFile(before, after) ||
    bytes.length !== row.size_bytes
  )
    throw new ApiError(
      "The PDF changed during download. Wait for the next FTP check.",
      409,
    );
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-")
    throw new ApiError("This file is not a readable PDF.", 422);
  const sha256 = digest(bytes);
  if (row.sha256 && row.sha256 !== sha256)
    throw new ApiError(
      "The PDF changed. Ask the sender to upload it with a new name.",
      409,
    );
  const existing = await duplicateCase(db, sha256, owner);
  if (existing) return { ...existing, sha256 };

  await storeImportedPdf(
    db,
    owner,
    {
      id: row.id,
      name: row.file_name,
      storageName: "invoice.pdf",
      bytes,
    },
    "FTP",
  );
  // Same asset ID across retries lets the existing RPC return a case already
  // created before a worker restart. Older SAP Test cases have separate scope.
  const attach = (allowDuplicate: boolean) =>
    db.rpc("attach_case_uploads", {
      p_user: owner,
      p_upload_ids: [row.id],
      p_case_id: null,
      p_mode: "append",
      p_allow_duplicate: allowDuplicate,
    });
  let attached = await attach(false);
  dbCheck(attached.error);
  const duplicate = attached.data?.duplicateCase;
  if (duplicate) {
    const candidate = await db
      .from("packet_cases")
      .select("created_at,processing_meta")
      .eq("id", duplicate.id)
      .eq("owner_user_id", owner)
      .is("deleted_at", null)
      .maybeSingle();
    dbCheck(candidate.error);
    if (
      candidate.data &&
      sapCaseEnvironment(
        sapCaseOrigin(
          candidate.data.created_at,
          candidate.data.processing_meta,
        ),
      ) === "live"
    )
      return { caseId: duplicate.id as string, owner, sha256 };
    const concurrent = await duplicateCase(db, sha256, owner);
    if (concurrent) return { ...concurrent, sha256 };
    attached = await attach(true);
    dbCheck(attached.error);
  }
  if (!attached.data?.case?.id)
    throw new Error("Could not create the invoice case.");
  return { caseId: attached.data.case.id as string, owner, sha256 };
}

async function queueAnalysis(db: Db, ftp: InvoiceFtp, row: FtpInvoiceRow) {
  let owner = row.owner_user_id;
  if (!owner) throw new ApiError("The original reviewer is unavailable.", 409);
  let caseId = row.case_id;
  if (!caseId) {
    // Recover a saved case even if the remote file disappeared after upload.
    const consumed = await db
      .from("storage_assets")
      .select("consumed_case_id,content_sha256")
      .eq("id", row.id)
      .eq("owner_user_id", owner)
      .maybeSingle();
    dbCheck(consumed.error);
    const imported = consumed.data?.consumed_case_id
      ? {
          caseId: consumed.data.consumed_case_id as string,
          owner,
          sha256: consumed.data.content_sha256 as string,
        }
      : await importPdf(db, ftp, row, owner);
    caseId = imported.caseId;
    owner = imported.owner;
    await update(
      db,
      row.id,
      { case_id: caseId, owner_user_id: owner, sha256: imported.sha256 },
      "importing",
    );
  }
  const job = await latestJob(db, caseId);
  if (job?.status === "succeeded") {
    await update(
      db,
      row.id,
      { status: "archive_pending", analysis_job_id: job.id, error: null },
      "importing",
    );
    return;
  }
  if (job && ["queued", "running"].includes(job.status)) {
    await update(
      db,
      row.id,
      { status: "analyzing", analysis_job_id: job.id, error: null },
      "importing",
    );
    return;
  }
  if (
    job &&
    row.requested_at &&
    Date.parse(job.created_at) >= Date.parse(row.requested_at)
  )
    throw new ApiError("Analysis failed. Retry it from the inbox.", 409);
  if (!process.env.OPENROUTER_API_KEY)
    throw new ApiError(
      "Invoice analysis is unavailable. Try again later.",
      503,
    );
  const result = await db.rpc("enqueue_case_analysis", {
    p_user: owner,
    p_case: caseId,
    p_options: {
      analysisMode: "standard",
      comparisonOptions: DEFAULT_COMPARISON_OPTIONS,
    },
  });
  dbCheck(result.error);
  if (!isConfirmedAnalysisStart(result.data))
    throw new Error("Analysis queue did not confirm the case.");
  await update(
    db,
    row.id,
    { status: "analyzing", analysis_job_id: result.data.job.id, error: null },
    "importing",
  );
}

async function reconcileAnalysis(db: Db) {
  const pending = await db
    .from(table)
    .select("id,analysis_job_id,case_id")
    .eq("status", "analyzing")
    .order("requested_at")
    .limit(100);
  dbCheck(pending.error);
  const rows = pending.data ?? [];
  const ids = rows.flatMap((row) =>
    row.analysis_job_id ? [row.analysis_job_id] : [],
  );
  const jobs = ids.length
    ? await db.from("packet_processing_jobs").select("id,status").in("id", ids)
    : { data: [], error: null };
  dbCheck(jobs.error);
  const statuses = new Map(
    (jobs.data ?? []).map((job) => [job.id, job.status]),
  );
  for (const row of rows) {
    const status = statuses.get(row.analysis_job_id);
    if (status === "succeeded") {
      await update(
        db,
        row.id,
        { status: "archive_pending", error: null },
        "analyzing",
      );
    } else if (!status || status === "failed" || status === "cancelled") {
      await update(
        db,
        row.id,
        {
          status: "failed",
          error: "Analysis did not finish. Retry from the inbox.",
        },
        "analyzing",
      );
    }
  }
}

export async function archiveProcessedInvoice(
  db: Db,
  ftp: InvoiceFtp,
  row: FtpInvoiceRow,
) {
  if (!row.sha256 || !row.case_id)
    throw new Error("Archived file requires saved source evidence.");
  const destination =
    row.archive_name ?? archiveFilename(row.file_name, row.id);
  if (!row.archive_name)
    await update(db, row.id, { archive_name: destination }, "archive_pending");

  const [inbox, archive] = await Promise.all([
    ftp.list("in"),
    ftp.list("archive"),
  ]);
  const original = inbox.find((entry) => entry.name === row.file_name);
  const archived = archive.find((entry) => entry.name === destination);
  if (archived) {
    // The prior move may have succeeded before the worker saved its result.
    if (
      archived.size !== row.size_bytes ||
      digest(await ftp.download("archive", destination)) !== row.sha256
    )
      throw new ApiError(
        "The archive contains a different file at this name.",
        409,
      );
  } else {
    if (
      !original ||
      !sameRemoteFile(original, remoteInvoice(row)) ||
      digest(await ftp.download("in", row.file_name)) !== row.sha256
    )
      throw new ApiError(
        "The source PDF changed or was removed. The case is ready for review.",
        409,
      );
    const confirmed = (await ftp.list("in")).find(
      (entry) => entry.name === row.file_name,
    );
    if (!confirmed || !sameRemoteFile(original, confirmed))
      throw new ApiError(
        "The source PDF changed during the archive check.",
        409,
      );
    await ftp.archive(row.file_name, destination);
  }
  await update(
    db,
    row.id,
    { status: "archived", present: false, error: null, next_archive_at: null },
    "archive_pending",
  );
}

function userError(error: unknown, fallback: string) {
  return error instanceof ApiError || error instanceof InboxFtpError
    ? error.message
    : fallback;
}

export async function runInvoiceInboxCycle(
  db: Db,
  ftp: InvoiceFtp,
  now = new Date(),
) {
  const token = randomUUID();
  const lease = await db
    .from("ftp_invoice_sync")
    .update({
      lock_token: token,
      lease_until: new Date(now.getTime() + 240_000).toISOString(),
    })
    .eq("id", 1)
    .lt("lease_until", now.toISOString())
    .select("last_checked_at,error")
    .maybeSingle();
  checkInboxError(lease.error);
  if (!lease.data) return;
  try {
    const elapsed =
      now.getTime() - Date.parse(lease.data.last_checked_at ?? "");
    if (!Number.isFinite(elapsed) || elapsed >= SCAN_INTERVAL_MS) {
      let error: string | null = null;
      try {
        await discoverInvoices(db, await ftp.list("in"));
      } catch (failure) {
        error = userError(
          failure,
          "The invoice inbox could not refresh. The worker will retry.",
        );
        console.warn("[invoice-inbox] FTP check failed:", error);
      }
      const checkedAt = new Date().toISOString();
      const synced = await db
        .from("ftp_invoice_sync")
        .update({
          last_checked_at: checkedAt,
          error,
          ...(error ? {} : { last_success_at: checkedAt }),
        })
        .eq("id", 1)
        .eq("lock_token", token);
      dbCheck(synced.error);
      lease.data.error = error;
    }

    await reconcileAnalysis(db);
    if (lease.data.error) return;
    // Give imports priority and do at most one FTP operation chain per lease.
    const queued = await db
      .from(table)
      .select("*")
      .in("status", ["queued", "importing"])
      .order("requested_at")
      .limit(1)
      .maybeSingle();
    dbCheck(queued.error);
    const row = queued.data as FtpInvoiceRow | null;
    if (row) {
      await update(db, row.id, { status: "importing" }, row.status);
      try {
        await queueAnalysis(db, ftp, row);
      } catch (failure) {
        const error = userError(
          failure,
          "Could not start analysis. Retry from the inbox.",
        );
        await update(db, row.id, { status: "failed", error }, "importing");
      }
      return;
    }
    const pending = await db
      .from(table)
      .select("*")
      .eq("status", "archive_pending")
      .or(`next_archive_at.is.null,next_archive_at.lte.${now.toISOString()}`)
      .order("requested_at")
      .limit(1)
      .maybeSingle();
    dbCheck(pending.error);
    if (pending.data) {
      const row = pending.data as FtpInvoiceRow;
      try {
        await archiveProcessedInvoice(db, ftp, row);
      } catch (failure) {
        const error = userError(
          failure,
          "The PDF archive move needs a retry. The case is ready for review.",
        );
        await update(
          db,
          row.id,
          {
            error,
            next_archive_at: new Date(
              Date.now() + SCAN_INTERVAL_MS,
            ).toISOString(),
          },
          "archive_pending",
        );
      }
    }
  } finally {
    const released = await db
      .from("ftp_invoice_sync")
      .update({ lease_until: new Date().toISOString(), lock_token: null })
      .eq("id", 1)
      .eq("lock_token", token);
    dbCheck(released.error);
  }
}

export async function runProductionInvoiceInbox() {
  if (
    readSapEnvironment() !== "live" ||
    process.env.FTP_INBOX_ENABLED !== "true"
  )
    return;
  await runInvoiceInboxCycle(
    createSupabaseAdminClient({ fetchTimeoutMs: 15_000 }),
    createInvoiceFtp(),
  );
}
