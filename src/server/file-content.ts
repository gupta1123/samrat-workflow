import { FILE_CHUNK_BYTES } from "@/lib/file-transfer";
import { createSupabaseFetch } from "@/lib/supabase/fetch";
import { getSupabaseServerUrl } from "@/lib/supabase/config";
import { ApiError } from "./api/helpers";

export function requestedFileRange(header: string | null, size: number) {
  if (!header) {
    if (size > 3 * 1024 * 1024)
      throw new ApiError(
        "Open this document inside the case to load it in verified parts.",
        413,
      );
    return null;
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(header);
  const start = Number(match?.[1]);
  const end = Number(match?.[2]);
  if (
    !match ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= size ||
    end - start + 1 > FILE_CHUNK_BYTES
  )
    throw new ApiError("Invalid document byte range.", 416);
  return { start, end };
}

export async function privateFileContent(
  request: Request,
  file: {
    storage_path: string;
    original_name: string;
    mime_type: string | null;
    size_bytes: number;
  },
  deps: { url?: string; key?: string; fetcher?: typeof fetch } = {},
) {
  const range = requestedFileRange(
    request.headers.get("range"),
    file.size_bytes,
  );
  const url = deps.url || getSupabaseServerUrl();
  const key = deps.key || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Storage configuration unavailable");
  const target = `${url.replace(/\/$/, "")}/storage/v1/object/packet-files/${file.storage_path.split("/").map(encodeURIComponent).join("/")}`;
  const response = await createSupabaseFetch(45_000, deps.fetcher)(target, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
    },
    redirect: "error",
    cache: "no-store",
    signal: request.signal,
  });
  if (response.status === 404 || response.status === 400)
    throw new ApiError("File content is unavailable.", 404);
  if (!response.ok)
    throw new ApiError(
      "File storage is temporarily unavailable. Reopen the document to retry.",
      503,
    );
  const expectedRange = range
    ? `bytes ${range.start}-${range.end}/${file.size_bytes}`
    : null;
  if (
    range &&
    (response.status !== 206 ||
      response.headers.get("content-range") !== expectedRange)
  )
    throw new ApiError("Storage returned an invalid document range.", 503);
  const bytes = await response.arrayBuffer();
  if (
    bytes.byteLength !== (range ? range.end - range.start + 1 : file.size_bytes)
  )
    throw new ApiError(
      "The document transfer was incomplete. Reopen it to retry.",
      503,
    );
  return new Response(bytes, {
    status: range ? 206 : 200,
    headers: {
      "Content-Type": file.mime_type || "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
      ...(expectedRange ? { "Content-Range": expectedRange } : {}),
    },
  });
}
