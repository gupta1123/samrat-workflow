import { apiFetch } from "./api-client";
import { createSupabaseFetch } from "./supabase/fetch";
import {
  FILE_CHUNK_BYTES,
  FILE_REQUEST_TIMEOUT_MS,
  MAX_FILE_BYTES,
  TRANSFER_ID_HEADER,
  filePartCount,
  sha256,
} from "./file-transfer";

type Operation =
  "prepare" | "status" | "part" | "complete" | "metadata" | "download";
type Dependencies = {
  fetcher?: typeof apiFetch;
  timeoutMs?: number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export class FileTransferError extends Error {
  constructor(
    message: string,
    public status: number,
    public requestId: string,
  ) {
    super(`${message} Reference: ${requestId}.`);
    this.name = "FileTransferError";
  }
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const cancel = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

export async function transferFetch(
  path: string,
  operation: Operation,
  init: RequestInit = {},
  deps: Dependencies = {},
) {
  if (
    !/^\/api\/(uploads(?:\/|$)|cases\/[^/]+\/files\?)/.test(path) ||
    path.startsWith("//")
  )
    throw new Error("Invalid file transfer destination.");
  const fetcher = deps.fetcher || apiFetch;
  const bounded = createSupabaseFetch(
    deps.timeoutMs ?? FILE_REQUEST_TIMEOUT_MS,
    (input, options) => fetcher(String(input), options),
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    init.signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    const headers = new Headers(init.headers);
    headers.set(TRANSFER_ID_HEADER, requestId);
    const started = Date.now();
    let failure = "network";
    let status = 0;
    try {
      const response = await bounded(path, {
        ...init,
        headers,
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
      });
      if (response.ok) return response;
      failure = "http";
      status = response.status;
      const body = await response.json().catch(() => ({}));
      const text =
        typeof body.error === "string"
          ? body.error
          : `The file request failed (HTTP ${status}).`;
      throw new FileTransferError(
        text,
        status,
        response.headers.get(TRANSFER_ID_HEADER) || requestId,
      );
    } catch (error) {
      if (init.signal?.aborted) throw error;
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") failure = "timeout";
      // No file contents, names, paths, hashes, signed URLs, or credentials.
      void fetcher("/api/uploads/diagnostics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          requestId,
          operation,
          failure,
          status,
          durationMs: Date.now() - started,
        }),
      }).catch(() => {});
      if (
        attempt < 2 &&
        (!status || [408, 425, 429].includes(status) || status >= 500)
      ) {
        await (deps.wait || delay)(
          1000 * (attempt + 1),
          init.signal || undefined,
        );
        continue;
      }
      if (error instanceof FileTransferError) throw error;
      throw new FileTransferError(
        failure === "timeout"
          ? "The file transfer took too long. Retry to continue from the saved parts."
          : "The file transfer could not reach the website. Retry to continue from the saved parts.",
        0,
        requestId,
      );
    }
  }
  throw new Error("File transfer could not finish.");
}

type UploadSession = { id: string; chunkSize: number };
const sessions = new WeakMap<File, UploadSession>();

export async function uploadFileThroughWebsite(
  file: File,
  digest: string,
  deps: Dependencies = {},
) {
  let session = sessions.get(file);
  let received = new Set<number>();
  if (session) {
    try {
      const response = await transferFetch(
        `/api/uploads/${session.id}`,
        "status",
        {},
        deps,
      );
      const status = await response.json();
      if (status.complete === true) return session.id;
      received = new Set(Array.isArray(status.received) ? status.received : []);
    } catch (error) {
      if (
        !(error instanceof FileTransferError) ||
        ![404, 410].includes(error.status)
      )
        throw error;
      session = undefined;
      sessions.delete(file);
    }
  }
  if (!session) {
    const response = await transferFetch(
      "/api/uploads",
      "prepare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          sha256: digest,
          transport: "relay-v1",
          uploadId: crypto.randomUUID(),
        }),
      },
      deps,
    );
    const body = await response.json();
    if (
      typeof body.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(body.id) ||
      body.chunkSize !== FILE_CHUNK_BYTES
    )
      throw new Error("The website returned an invalid upload reservation.");
    session = { id: body.id, chunkSize: body.chunkSize };
    sessions.set(file, session);
  }
  for (let part = 0; part < filePartCount(file.size); part++) {
    if (received.has(part)) continue;
    const chunk = file.slice(
      part * session.chunkSize,
      Math.min(file.size, (part + 1) * session.chunkSize),
    );
    const checksum = await sha256(await chunk.arrayBuffer());
    await transferFetch(
      `/api/uploads/${session.id}?part=${part}`,
      "part",
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Samrat-Part-Sha256": checksum,
        },
        body: chunk,
      },
      deps,
    );
  }
  const response = await transferFetch(
    `/api/uploads/${session.id}`,
    "complete",
    { method: "POST" },
    deps,
  );
  const complete = await response.json();
  if (complete.complete !== true || complete.id !== session.id)
    throw new Error(
      "The website has not confirmed the complete file. Retry the upload.",
    );
  return session.id;
}

/** Fetch authenticated byte ranges, then verify the original file before displaying it. */
export async function downloadPrivateDocument(
  source: string,
  signal?: AbortSignal,
  deps: Dependencies = {},
) {
  const infoUrl = new URL(source, "https://same-origin.invalid");
  infoUrl.searchParams.set("info", "1");
  const path = `${infoUrl.pathname}${infoUrl.search}`;
  const response = await transferFetch(path, "metadata", { signal }, deps);
  const info = await response.json();
  if (
    !Number.isSafeInteger(info.size) ||
    info.size < 1 ||
    info.size > MAX_FILE_BYTES ||
    !/^[0-9a-f]{64}$/.test(info.sha256) ||
    info.chunkSize !== FILE_CHUNK_BYTES
  )
    throw new Error("The document metadata could not be verified.");
  const data = new Uint8Array(info.size);
  const count = filePartCount(info.size);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, count) }, async () => {
      while (next < count) {
        const part = next++;
        signal?.throwIfAborted();
        const start = part * FILE_CHUNK_BYTES;
        const end = Math.min(info.size, start + FILE_CHUNK_BYTES) - 1;
        const chunk = await transferFetch(
          source,
          "download",
          { signal, headers: { Range: `bytes=${start}-${end}` } },
          deps,
        );
        if (
          chunk.status !== 206 ||
          chunk.headers.get("content-range") !==
            `bytes ${start}-${end}/${info.size}`
        )
          throw new Error("The website returned an invalid document range.");
        const bytes = new Uint8Array(await chunk.arrayBuffer());
        if (bytes.length !== end - start + 1)
          throw new Error(
            "The document transfer was incomplete. Reopen it to retry.",
          );
        data.set(bytes, start);
      }
    }),
  );
  signal?.throwIfAborted();
  if ((await sha256(data.buffer)) !== info.sha256)
    throw new Error(
      "The downloaded document did not match the original. Reopen it to retry.",
    );
  return new Blob([data.buffer], {
    type:
      typeof info.mimeType === "string"
        ? info.mimeType
        : "application/octet-stream",
  });
}
