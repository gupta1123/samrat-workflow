import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { ApiError, dbCheck, uuid } from "./api/helpers";
import type { createSupabaseAdminClient } from "./supabase/admin";
export const UPLOAD_LIMITS = {
  files: 20,
  bytes: 50 * 1024 * 1024,
  totalBytes: 100 * 1024 * 1024,
  pages: 40,
};

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type StorageAsset = {
  id: string;
  storage_path: string;
  original_name: string;
  content_sha256: string;
  size_bytes: number;
  mime_type: string;
  page_count: number | null;
};

function pageLimitMessage(pageCount: number) {
  const excess = pageCount - UPLOAD_LIMITS.pages;
  return `These files contain ${pageCount} pages. A case can contain a maximum of ${UPLOAD_LIMITS.pages} pages. Remove at least ${excess} ${excess === 1 ? "page" : "pages"} and try again.`;
}

async function countAndVerifyAssetPages(
  db: AdminClient,
  asset: StorageAsset,
) {
  const { data: blob, error: storageError } = await db.storage
    .from("packet-files")
    .download(asset.storage_path);
  if (storageError || !blob)
    throw new ApiError(
      `Upload not complete: ${asset.original_name}. Please retry.`,
    );

  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength !== asset.size_bytes)
    throw new ApiError(
      `Upload size differs for ${asset.original_name}. Upload the file again.`,
    );
  if (createHash("sha256").update(bytes).digest("hex") !== asset.content_sha256)
    throw new ApiError(
      `Upload contents differ for ${asset.original_name}. Upload the file again.`,
    );

  if (!/\.pdf$/i.test(asset.original_name)) return 1;

  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const pages = pdf.getPageCount();
    if (pages < 1) throw new Error("PDF has no pages");
    return pages;
  } catch {
    throw new ApiError(
      `We couldn't read the page count in "${asset.original_name}". Check that it is a valid, unencrypted PDF and try again.`,
    );
  }
}

async function persistVerifiedPageCount(
  db: AdminClient,
  asset: StorageAsset,
) {
  const pageCount = await countAndVerifyAssetPages(db, asset);
  const { error } = await db
    .from("storage_assets")
    .update({ page_count: pageCount })
    .eq("id", asset.id);
  dbCheck(error);
  return pageCount;
}

export async function ensureCaseFilePageCounts(
  db: AdminClient,
  userId: string,
  caseId: string,
) {
  const { data, error } = await db
    .from("packet_case_files")
    .select("storage_assets!inner(*)")
    .eq("case_id", caseId);
  dbCheck(error);

  for (const row of data || []) {
    const joined = row.storage_assets as unknown;
    const asset = (Array.isArray(joined) ? joined[0] : joined) as
      | StorageAsset
      | undefined;
    if (!asset || asset.page_count !== null) continue;

    const { data: owned, error: ownerError } = await db
      .from("storage_assets")
      .select("*")
      .eq("id", asset.id)
      .eq("owner_user_id", userId)
      .maybeSingle();
    dbCheck(ownerError);
    if (!owned) throw new ApiError("One or more case files were not found.", 404);
    await persistVerifiedPageCount(db, owned as StorageAsset);
  }
}
export function validateUpload(input: Record<string, unknown>) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const extension = name.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
  };
  if (
    !name ||
    name.length > 240 ||
    /[\x00-\x1f/\\]/.test(name) ||
    !extension ||
    !types[extension]
  )
    throw new ApiError(
      "Choose a PDF, JPG, PNG, WebP, HEIC or HEIF document with a valid filename.",
    );
  const size = Number(input.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > UPLOAD_LIMITS.bytes)
    throw new ApiError("Each file must be non-empty and no larger than 50 MB.");
  if (typeof input.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.sha256))
    throw new ApiError("Invalid file checksum.");
  return { name, size, sha256: input.sha256, mime: types[extension] };
}
export async function verifyUploads(
  db: AdminClient,
  userId: string,
  value: unknown,
) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > UPLOAD_LIMITS.files
  )
    throw new ApiError("Select between 1 and 20 files.");
  const ids = value.map(uuid);
  if (new Set(ids).size !== ids.length)
    throw new ApiError("Duplicate upload reference.");
  const { data, error } = await db
    .from("storage_assets")
    .select("*")
    .eq("owner_user_id", userId)
    .in("id", ids);
  dbCheck(error);
  if (data?.length !== ids.length)
    throw new ApiError("One or more uploads were not found.", 404);
  if (data.reduce((sum, f) => sum + f.size_bytes, 0) > UPLOAD_LIMITS.totalBytes)
    throw new ApiError("The files in one case must total 100 MB or less.");
  let totalPages = 0;
  // Count and hash the immutable stored bytes, not browser-supplied metadata.
  for (const asset of data) {
    totalPages += await persistVerifiedPageCount(db, asset as StorageAsset);
    if (totalPages > UPLOAD_LIMITS.pages)
      throw new ApiError(pageLimitMessage(totalPages));
  }
  return ids;
}
