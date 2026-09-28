import { dbCheck, jsonBody, withUser } from "@/server/api/helpers";
import { validateUpload } from "@/server/uploads";
import { randomUUID } from "node:crypto";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return withUser(request, async (db, user) => {
    const file = validateUpload(await jsonBody(request));
    const id = randomUUID();
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
    dbCheck(error);
    const { data, error: signError } = await db.storage
      .from("packet-files")
      .createSignedUploadUrl(path, { upsert: false });
    dbCheck(signError);
    return { id, path: data!.path, token: data!.token };
  });
}
