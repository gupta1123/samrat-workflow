import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { ApiError, dbCheck } from "@/server/api/helpers";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";

type Db = ReturnType<typeof createSupabaseAdminClient>;

export async function storeImportedPdf(
  db: Db,
  user: string,
  file: { id: string; name: string; bytes: Buffer; storageName?: string },
  sourceLabel = "SAP",
) {
  let pages: number;
  try {
    pages = (
      await PDFDocument.load(file.bytes, { updateMetadata: false })
    ).getPageCount();
  } catch {
    throw new ApiError(
      `${sourceLabel} PDF is invalid or encrypted. No analysis was started.`,
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
      p_path: `${user}/${file.id}/${file.storageName ?? file.name}`,
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
      `${sourceLabel} attachment changed during this import. Start again with a fresh import session.`,
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
      throw new ApiError(
        `Could not save the ${sourceLabel} PDF. Retry this import.`,
        503,
      );
  }
  const saved = await db
    .from("storage_assets")
    .update({ page_count: pages })
    .eq("id", file.id)
    .eq("owner_user_id", user);
  dbCheck(saved.error);
  return { id: file.id, sha256: sha, pages };
}
