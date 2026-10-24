import { ApiError, dbCheck, jsonBody, uuid } from "@/server/api/helpers";
import { validateUpload } from "@/server/uploads";
import { randomUUID } from "node:crypto";
import { FILE_CHUNK_BYTES } from "@/lib/file-transfer";
import { fileTransferRequest } from "@/server/file-transfer";
import { ownedUpload } from "@/server/upload-relay";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return fileTransferRequest(request, "prepare", async (db, user) => {
    const body = await jsonBody(request);
    const file = validateUpload(body);
    const relay = body.transport === "relay-v1";
    const id = relay && body.uploadId ? uuid(body.uploadId) : randomUUID();
    const existingReservation = async () => {
      const asset = await ownedUpload(db, user, id);
      if (
        asset.content_sha256 !== file.sha256 ||
        asset.size_bytes !== file.size ||
        asset.original_name !== file.name
      )
        throw new ApiError(
          "This upload reference belongs to a different file.",
          409,
        );
      return { id, chunkSize: FILE_CHUNK_BYTES };
    };
    if (relay && body.uploadId) {
      try {
        return await existingReservation();
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
      }
    }
    const path = `${user}/${id}/${file.name}`;
    const { error } = await db.rpc("reserve_upload", {
      p_id: id,
      p_user: user,
      p_path: path,
      p_name: file.name,
      p_size: file.size,
      p_sha: file.sha256,
      p_mime: file.mime,
    });
    if (relay && error?.code === "23505") return existingReservation();
    dbCheck(error);
    if (relay) return { id, chunkSize: FILE_CHUNK_BYTES };
    const { data, error: signError } = await db.storage
      .from("packet-files")
      .createSignedUploadUrl(path, { upsert: false });
    dbCheck(signError);
    return { id, path: data!.path, token: data!.token };
  });
}
