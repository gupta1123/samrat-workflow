import { createHash } from "node:crypto";
import {
  FILE_CHUNK_BYTES,
  filePartCount,
  filePartSize,
} from "@/lib/file-transfer";
import { ApiError, dbCheck, uuid } from "./api/helpers";
import type { TransferDb } from "./file-transfer";

export type RelayAsset = {
  id: string;
  owner_user_id: string;
  storage_path: string;
  original_name: string;
  size_bytes: number;
  content_sha256: string;
  mime_type: string;
  created_at: string;
  consumed_case_id: string | null;
};

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const uploadPartFolder = (path: string) =>
  `${path.slice(0, path.lastIndexOf("/"))}/.relay-v1`;
const partPath = (asset: RelayAsset, part: number) =>
  `${uploadPartFolder(asset.storage_path)}/${String(part).padStart(4, "0")}.part`;

export async function ownedUpload(db: TransferDb, user: string, id: string) {
  const result = await db
    .from("storage_assets")
    .select(
      "id,owner_user_id,storage_path,original_name,size_bytes,content_sha256,mime_type,created_at,consumed_case_id",
    )
    .eq("id", uuid(id))
    .eq("owner_user_id", user)
    .maybeSingle();
  dbCheck(result.error);
  const asset = result.data as RelayAsset | null;
  if (!asset || !asset.storage_path.startsWith(`${user}/${asset.id}/`))
    throw new ApiError("Upload not found.", 404);
  if (Date.parse(asset.created_at) < Date.now() - 24 * 60 * 60 * 1000)
    throw new ApiError("This upload has expired. Select the file again.", 410);
  return asset;
}

function missing(error: unknown) {
  const value = error as {
    statusCode?: string | number;
    status?: number;
    message?: string;
  };
  return (
    Number(value?.statusCode ?? value?.status) === 404 ||
    /object not found|not found/i.test(value?.message || "")
  );
}

async function existingFile(db: TransferDb, asset: RelayAsset) {
  const result = await db.storage.from("packet-files").info(asset.storage_path);
  if (result.error) {
    if (missing(result.error)) return false;
    throw result.error;
  }
  if (result.data.size !== asset.size_bytes)
    throw new ApiError(
      "The stored file has a different size. Select the file again.",
      409,
    );
  return true;
}

async function verifiedExistingFile(db: TransferDb, asset: RelayAsset) {
  if (!(await existingFile(db, asset))) return false;
  const result = await db.storage
    .from("packet-files")
    .download(asset.storage_path);
  if (result.error || !result.data)
    throw result.error || new Error("Storage read failed");
  const bytes = new Uint8Array(await result.data.arrayBuffer());
  if (bytes.length !== asset.size_bytes || hash(bytes) !== asset.content_sha256)
    throw new ApiError(
      "File verification failed. Select the original file again.",
      422,
    );
  return true;
}

export async function uploadStatus(db: TransferDb, asset: RelayAsset) {
  if (await verifiedExistingFile(db, asset))
    return {
      id: asset.id,
      complete: true,
      received: [],
      chunkSize: FILE_CHUNK_BYTES,
    };
  const result = await db.storage
    .from("packet-files")
    .list(uploadPartFolder(asset.storage_path), {
      limit: 100,
      sortBy: { column: "name", order: "asc" },
    });
  if (result.error) throw result.error;
  const received = (result.data || []).flatMap((file) => {
    const part = /^\d{4}\.part$/.test(file.name)
      ? Number(file.name.slice(0, 4))
      : -1;
    return part >= 0 &&
      part < filePartCount(asset.size_bytes) &&
      Number(file.metadata?.size) === filePartSize(asset.size_bytes, part)
      ? [part]
      : [];
  });
  return {
    id: asset.id,
    complete: false,
    received,
    chunkSize: FILE_CHUNK_BYTES,
  };
}

export async function receiveUploadPart(
  db: TransferDb,
  asset: RelayAsset,
  part: number,
  bytes: Uint8Array,
  expectedHash: string,
) {
  if (asset.consumed_case_id)
    throw new ApiError("This upload already belongs to a case.", 409);
  if (
    !Number.isInteger(part) ||
    part < 0 ||
    part >= filePartCount(asset.size_bytes)
  )
    throw new ApiError("Invalid file part.");
  if (bytes.length !== filePartSize(asset.size_bytes, part))
    throw new ApiError("File part size differs. Please retry.", 422);
  if (!/^[0-9a-f]{64}$/.test(expectedHash) || hash(bytes) !== expectedHash)
    throw new ApiError("File part verification failed. Please retry.", 422);
  const path = partPath(asset, part);
  const result = await db.storage.from("packet-files").upload(path, bytes, {
    contentType: "application/octet-stream",
    upsert: false,
  });
  if (result.error) {
    // A lost response may follow a successful write. Accept only identical bytes;
    // never overwrite a chunk that another request is finalizing.
    const previous = await db.storage.from("packet-files").download(path);
    if (previous.error || !previous.data) throw result.error;
    const saved = new Uint8Array(await previous.data.arrayBuffer());
    if (saved.length !== bytes.length || hash(saved) !== expectedHash)
      throw new ApiError(
        "A different file part is already saved. Select the original file again.",
        409,
      );
  }
  return { id: asset.id, part, received: bytes.length };
}

export async function removeUploadParts(db: TransferDb, path: string) {
  const folder = uploadPartFolder(path);
  const listed = await db.storage
    .from("packet-files")
    .list(folder, { limit: 100 });
  if (listed.error) throw listed.error;
  const paths = (listed.data || [])
    .filter((file) => /^\d{4}\.part$/.test(file.name))
    .map((file) => `${folder}/${file.name}`);
  if (paths.length) {
    const result = await db.storage.from("packet-files").remove(paths);
    if (result.error) throw result.error;
  }
}

/** Retry rare post-finalization cleanup failures after a case consumed the file. */
export async function cleanupConsumedUploadParts(db: TransferDb) {
  let after: string | null = null;
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  while (true) {
    let query = db
      .from("storage_assets")
      .select("id,storage_path")
      .not("consumed_case_id", "is", null)
      .gte("created_at", since)
      .order("id")
      .limit(100);
    if (after) query = query.gt("id", after);
    const result = await query;
    dbCheck(result.error);
    const assets = result.data || [];
    for (let start = 0; start < assets.length; start += 4)
      await Promise.all(
        assets
          .slice(start, start + 4)
          .map((asset) => removeUploadParts(db, asset.storage_path)),
      );
    if (assets.length < 100) return;
    after = assets[assets.length - 1].id;
  }
}

export async function completeUpload(db: TransferDb, asset: RelayAsset) {
  if (await verifiedExistingFile(db, asset))
    return { id: asset.id, complete: true };
  if (asset.consumed_case_id)
    throw new ApiError("This upload already belongs to a case.", 409);
  const parts: Uint8Array[] = new Array(filePartCount(asset.size_bytes));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, parts.length) }, async () => {
      while (next < parts.length) {
        const part = next++;
        const result = await db.storage
          .from("packet-files")
          .download(partPath(asset, part));
        if (result.error || !result.data) {
          if (result.error && !missing(result.error)) throw result.error;
          throw new ApiError(
            "Some file parts are missing. Retry the upload to continue.",
            409,
          );
        }
        parts[part] = new Uint8Array(await result.data.arrayBuffer());
        if (parts[part].length !== filePartSize(asset.size_bytes, part))
          throw new ApiError(
            "File part verification failed. Select the original file again.",
            422,
          );
      }
    }),
  );
  const bytes = Buffer.concat(parts, asset.size_bytes);
  if (bytes.length !== asset.size_bytes || hash(bytes) !== asset.content_sha256)
    throw new ApiError(
      "File verification failed. Select the original file again.",
      422,
    );
  const saved = await db.storage
    .from("packet-files")
    .upload(asset.storage_path, bytes, {
      contentType: asset.mime_type,
      upsert: false,
    });
  if (saved.error && !(await verifiedExistingFile(db, asset)))
    throw saved.error;
  // Cleanup failures must not report an intact final file as a failed upload.
  try {
    await removeUploadParts(db, asset.storage_path);
  } catch {
    console.warn(
      JSON.stringify({
        scope: "file-transfer",
        operation: "cleanup-parts",
        outcome: "deferred",
      }),
    );
  }
  return { id: asset.id, complete: true };
}
