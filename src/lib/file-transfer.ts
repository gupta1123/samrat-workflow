// Keep binary requests well below the hosting adapter's request/response limit.
export const FILE_CHUNK_BYTES = 512 * 1024;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const FILE_REQUEST_TIMEOUT_MS = 75_000;
export const TRANSFER_ID_HEADER = "X-Samrat-Transfer-Id";

export function filePartCount(size: number) {
  return Math.ceil(size / FILE_CHUNK_BYTES);
}

export function filePartSize(size: number, part: number) {
  return Math.min(FILE_CHUNK_BYTES, size - part * FILE_CHUNK_BYTES);
}

export async function sha256(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
