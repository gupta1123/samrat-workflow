import {
  readSapEnvironment,
  sapCaseEnvironment,
  sapCaseOrigin,
  type SapEnvironment,
} from "./config";
import { createHash } from "node:crypto";
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
  environment: SapEnvironment = readSapEnvironment(),
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
    .contains("details", { company, environment })
    .in("details->>docEntry", entries)
    .order("created_at", { ascending: false });
  dbCheck(events.error);
  if (!events.data?.length) return states;
  const cases = await db
    .from("packet_cases")
    .select("id,status,deleted_at,created_at,processing_meta")
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
      sapCaseEnvironment(sapCaseOrigin(c.created_at, c.processing_meta)) !==
        environment ||
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
        sapDraft: { status: "unavailable" },
      };
  }
  const linked = Object.values(states);
  if (!linked.length) return states;
  const postings = await db
    .from("sap_postings")
    .select(
      "case_id,status,sap_docnum,draftSubmissionPending:payload->>draftSubmissionPending,documentType:payload->>documentType,docEntry:response->>DocEntry,draftDocEntry:response->>DraftDocEntry,docNum:response->>DocNum",
    )
    .eq("owner_user_id", user)
    .eq("kind", "AP")
    .eq("sap_env", environment)
    .in("case_id", [...new Set(linked.map((state) => state.caseId))]);
  // Missing posting data must never become a false "Not drafted" badge.
  if (postings.error) {
    console.error("Could not read SAP draft status for imported receipts");
    return states;
  }
  const positiveId = (value: unknown) => {
    const n =
      typeof value === "number" || typeof value === "string"
        ? Number(value)
        : NaN;
    return Number.isSafeInteger(n) && n > 0 ? String(n) : undefined;
  };
  const byCase = new Map(
    postings.data?.map((posting) => [posting.case_id, posting]),
  );
  for (const state of linked) {
    const posting = byCase.get(state.caseId);
    if (posting?.draftSubmissionPending === "true") continue;
    if (!posting || ["failed", "blocked"].includes(posting.status)) {
      state.sapDraft = { status: "not_created" };
      continue;
    }
    const docEntry =
      positiveId(posting.draftDocEntry) ??
      positiveId(posting.docEntry) ??
      positiveId(posting.sap_docnum);
    if (!docEntry) continue;
    if (posting.status === "posted") {
      state.sapDraft = { status: "posted" };
    } else if (
      posting.status === "prepared" &&
      posting.documentType === "APInvoiceDraft"
    ) {
      state.sapDraft = {
        status: "created",
        docEntry,
        docNum: positiveId(posting.docNum),
      };
    }
  }
  return states;
}
export { storeImportedPdf as storeGrpoPdf } from "@/server/imported-pdf";
export async function attachGrpoPdfs(
  db: Db,
  user: string,
  ids: string[],
  source: {
    company: string;
    docEntry: number;
    docNum: number;
    environment?: SapEnvironment;
  },
) {
  const environment = source.environment ?? readSapEnvironment();
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
      "case_id,content_sha256,packet_cases!inner(owner_user_id,deleted_at,created_at,processing_meta)",
    )
    .eq("packet_cases.owner_user_id", user)
    .is("packet_cases.deleted_at", null)
    .in("content_sha256", hashes);
  dbCheck(candidates.error);
  const matchingFiles = (candidates.data ?? []).filter((file) => {
    const related: unknown = file.packet_cases;
    const joined = Array.isArray(related) ? related[0] : related;
    const row = joined as {
      created_at: unknown;
      processing_meta: unknown;
    } | null;
    if (!row) return false;
    return (
      sapCaseEnvironment(sapCaseOrigin(row.created_at, row.processing_meta)) ===
      environment
    );
  });
  // Exact byte matches also recognize a manually uploaded case containing extra documents.
  let caseId = [...new Set(matchingFiles.map((f) => f.case_id))].find((id) =>
    hashes.every((h) =>
      matchingFiles.some((f) => f.case_id === id && f.content_sha256 === h),
    ),
  );
  if (!caseId) {
    const attach = (allowDuplicate: boolean) =>
      db.rpc("attach_case_uploads", {
        p_user: user,
        p_upload_ids: ids,
        p_case_id: null,
        p_mode: "append",
        p_allow_duplicate: allowDuplicate,
      });
    let attached = await attach(false);
    dbCheck(attached.error);
    const duplicate = attached.data?.duplicateCase;
    if (duplicate && sapCaseEnvironment(duplicate.createdAt) !== environment) {
      // The same deterministic receipt batch is serialized by the existing RPC.
      attached = await attach(true);
      dbCheck(attached.error);
    }
    caseId = attached.data?.case?.id ?? attached.data?.duplicateCase?.id;
  }
  if (!caseId)
    throw new ApiError(
      "The PDFs were saved but the case could not be confirmed. Retry.",
      503,
    );
  const owned = await db
    .from("packet_cases")
    .select("id,status,deleted_at,created_at,processing_meta")
    .eq("id", caseId)
    .eq("owner_user_id", user)
    .maybeSingle();
  dbCheck(owned.error);
  if (!owned.data || owned.data.deleted_at)
    throw new ApiError(
      "This case is in Recycle Bin. Restore it before continuing.",
      409,
    );
  if (
    sapCaseEnvironment(
      sapCaseOrigin(owned.data.created_at, owned.data.processing_meta),
    ) !== environment
  )
    throw new ApiError(
      "This PDF belongs to a case from another SAP environment. Start a fresh import.",
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
      environment,
      uploadIds: ids,
      sha256s: hashes,
    },
  });
  dbCheck(event.error);
  return { caseId, status: owned.data.status };
}
