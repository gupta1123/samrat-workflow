import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { ApiError, dbCheck } from "@/server/api/helpers";
import { verifyUploads } from "@/server/uploads";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import type { GrpoUploadState } from "@/lib/grpo-import";
import type { SapInspectorRecord } from "@/lib/sap-inspector";

type Db = ReturnType<typeof createSupabaseAdminClient>;
export function importAssetId(
  user: string,
  company: string,
  entry: number,
  day: string,
  index: number,
  session = "",
) {
  const h = createHash("sha256")
    .update(
      JSON.stringify([
        "sap-grpo-pdf-v1",
        user,
        company,
        entry,
        day,
        index,
        session,
      ]),
    )
    .digest("hex")
    .slice(0, 32)
    .split("");
  h[12] = "5";
  h[16] = "8";
  const v = h.join("");
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20)}`;
}
export function importDay(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new ApiError("Invalid import session.");
  const elapsed = Date.now() - Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 2 * 86400000)
    throw new ApiError("Import session expired. Refresh and retry.", 409);
  return value;
}
export async function grpoUploadStates(
  db: Db,
  user: string,
  company: string,
  records: Pick<SapInspectorRecord, "docEntry">[],
) {
  const entries = records
    .map((r) => r.docEntry)
    .filter((id): id is string => !!id);
  const states: Record<string, GrpoUploadState> = {};
  if (!entries.length) return states;
  const events = await db
    .from("case_review_events")
    .select("case_id,details")
    .eq("owner_user_id", user)
    .eq("action", "sap_grpo_pdf_imported")
    .contains("details", { company, environment: "test" })
    .in("details->>docEntry", entries)
    .order("created_at", { ascending: false });
  dbCheck(events.error);
  if (!events.data?.length) return states;
  const cases = await db
    .from("packet_cases")
    .select("id,status,deleted_at")
    .eq("owner_user_id", user)
    .in("id", [...new Set(events.data.map((e) => e.case_id))]);
  dbCheck(cases.error);
  if (!cases.data?.length) return states;
  const files = await db
    .from("packet_case_files")
    .select("case_id,content_sha256")
    .in(
      "case_id",
      cases.data!.map((c) => c.id),
    );
  dbCheck(files.error);
  for (const event of events.data) {
    const c = cases.data?.find((c) => c.id === event.case_id);
    const entry = String(event.details?.docEntry);
    const hashes = event.details?.sha256s;
    const stored = new Set(
      files.data
        ?.filter((f) => f.case_id === event.case_id)
        .map((f) => f.content_sha256),
    );
    if (
      !c ||
      !Array.isArray(hashes) ||
      !hashes.length ||
      !hashes.every((h) => typeof h === "string" && stored.has(h))
    )
      continue;
    if (!states[entry] || (states[entry].deleted && !c.deleted_at))
      states[entry] = {
        caseId: c.id,
        status: c.status,
        deleted: !!c.deleted_at,
      };
  }
  return states;
}
export async function storeGrpoPdf(
  db: Db,
  user: string,
  file: { id: string; name: string; bytes: Buffer },
) {
  let pages: number;
  try {
    pages = (
      await PDFDocument.load(file.bytes, { updateMetadata: false })
    ).getPageCount();
  } catch {
    throw new ApiError(
      "SAP PDF is invalid or encrypted. No analysis was started.",
      422,
    );
  }
  if (pages < 1 || pages > 40)
    throw new ApiError(
      "A case supports a maximum of 40 pages. Select a smaller packet manually.",
      413,
    );
  const sha = createHash("sha256").update(file.bytes).digest("hex");
  let asset = await db
    .from("storage_assets")
    .select("*")
    .eq("id", file.id)
    .eq("owner_user_id", user)
    .maybeSingle();
  dbCheck(asset.error);
  if (!asset.data) {
    const reserved = await db.rpc("reserve_upload", {
      p_id: file.id,
      p_user: user,
      p_path: `${user}/${file.id}/${file.name}`,
      p_name: file.name,
      p_size: file.bytes.length,
      p_sha: sha,
      p_mime: "application/pdf",
    });
    if (reserved.error?.code !== "23505") dbCheck(reserved.error);
    asset = await db
      .from("storage_assets")
      .select("*")
      .eq("id", file.id)
      .eq("owner_user_id", user)
      .maybeSingle();
    dbCheck(asset.error);
  }
  if (
    !asset.data ||
    asset.data.content_sha256 !== sha ||
    asset.data.original_name !== file.name ||
    asset.data.size_bytes !== file.bytes.length
  )
    throw new ApiError(
      "SAP attachment changed during this import. Start again with a fresh import session.",
      409,
    );
  const uploaded = await db.storage
    .from("packet-files")
    .upload(asset.data.storage_path, file.bytes, {
      contentType: "application/pdf",
      upsert: false,
    });
  if (uploaded.error) {
    // A concurrent or lost-response retry may already have saved these exact bytes.
    const prior = await db.storage
      .from("packet-files")
      .download(asset.data.storage_path);
    if (
      prior.error ||
      !prior.data ||
      createHash("sha256")
        .update(Buffer.from(await prior.data.arrayBuffer()))
        .digest("hex") !== sha
    )
      throw new ApiError("Could not save the SAP PDF. Retry this import.", 503);
  }
  const saved = await db
    .from("storage_assets")
    .update({ page_count: pages })
    .eq("id", file.id)
    .eq("owner_user_id", user);
  dbCheck(saved.error);
  return { id: file.id, sha256: sha, pages };
}
export async function attachGrpoPdfs(
  db: Db,
  user: string,
  ids: string[],
  source: { company: string; docEntry: number; docNum: number },
) {
  await verifyUploads(db, user, ids);
  const imported = await db
    .from("storage_assets")
    .select("content_sha256")
    .eq("owner_user_id", user)
    .in("id", ids);
  dbCheck(imported.error);
  const hashes = imported.data!.map((a) => a.content_sha256);
  const candidates = await db
    .from("packet_case_files")
    .select(
      "case_id,content_sha256,packet_cases!inner(owner_user_id,deleted_at)",
    )
    .eq("packet_cases.owner_user_id", user)
    .is("packet_cases.deleted_at", null)
    .in("content_sha256", hashes);
  dbCheck(candidates.error);
  // Exact byte matches also recognize a manually uploaded case containing extra documents.
  let caseId = [...new Set(candidates.data!.map((f) => f.case_id))].find((id) =>
    hashes.every((h) =>
      candidates.data!.some((f) => f.case_id === id && f.content_sha256 === h),
    ),
  );
  if (!caseId) {
    const attached = await db.rpc("attach_case_uploads", {
      p_user: user,
      p_upload_ids: ids,
      p_case_id: null,
      p_mode: "append",
      p_allow_duplicate: false,
    });
    dbCheck(attached.error);
    caseId = attached.data?.case?.id ?? attached.data?.duplicateCase?.id;
  }
  if (!caseId)
    throw new ApiError(
      "The PDFs were saved but the case could not be confirmed. Retry.",
      503,
    );
  const owned = await db
    .from("packet_cases")
    .select("id,status,deleted_at")
    .eq("id", caseId)
    .eq("owner_user_id", user)
    .maybeSingle();
  dbCheck(owned.error);
  if (!owned.data || owned.data.deleted_at)
    throw new ApiError(
      "This case is in Recycle Bin. Restore it before continuing.",
      409,
    );
  const files = await db
    .from("packet_case_files")
    .select("content_sha256")
    .eq("case_id", caseId);
  dbCheck(files.error);
  if (!hashes.every((h) => files.data?.some((f) => f.content_sha256 === h)))
    throw new ApiError(
      "The imported PDFs are no longer attached to this case. Start a fresh import.",
      409,
    );
  const event = await db.from("case_review_events").insert({
    case_id: caseId,
    owner_user_id: user,
    action: "sap_grpo_pdf_imported",
    details: {
      ...source,
      environment: "test",
      uploadIds: ids,
      sha256s: hashes,
    },
  });
  dbCheck(event.error);
  return { caseId, status: owned.data.status };
}
