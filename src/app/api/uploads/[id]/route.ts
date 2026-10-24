import { FILE_CHUNK_BYTES } from "@/lib/file-transfer";
import { ApiError } from "@/server/api/helpers";
import { fileTransferRequest } from "@/server/file-transfer";
import {
  completeUpload,
  ownedUpload,
  receiveUploadPart,
  uploadStatus,
} from "@/server/upload-relay";

export const runtime = "nodejs";
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return fileTransferRequest(request, "status", async (db, user) =>
    uploadStatus(db, await ownedUpload(db, user, (await context.params).id)),
  );
}

export async function PUT(request: Request, context: Context) {
  return fileTransferRequest(request, "part", async (db, user) => {
    const asset = await ownedUpload(db, user, (await context.params).id);
    const rawPart = new URL(request.url).searchParams.get("part") || "";
    if (!/^\d{1,3}$/.test(rawPart)) throw new ApiError("Invalid file part.");
    if (Number(request.headers.get("content-length")) > FILE_CHUNK_BYTES)
      throw new ApiError("File part is too large.", 413);
    const reader = request.body?.getReader();
    if (!reader) throw new ApiError("File part is empty.");
    const pieces: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.length;
      if (length > FILE_CHUNK_BYTES) {
        await reader.cancel();
        throw new ApiError("File part is too large.", 413);
      }
      pieces.push(result.value);
    }
    return receiveUploadPart(
      db,
      asset,
      Number(rawPart),
      Buffer.concat(pieces),
      request.headers.get("X-Samrat-Part-Sha256") || "",
    );
  });
}

export async function POST(request: Request, context: Context) {
  return fileTransferRequest(request, "complete", async (db, user) =>
    completeUpload(db, await ownedUpload(db, user, (await context.params).id)),
  );
}
