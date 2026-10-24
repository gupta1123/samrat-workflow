import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { POST as prepare } from "../src/app/api/uploads/route";
import {
  GET as status,
  PUT as part,
  POST as complete,
} from "../src/app/api/uploads/[id]/route";
import { GET as files } from "../src/app/api/cases/[id]/files/route";
import { POST as diagnostics } from "../src/app/api/uploads/diagnostics/route";
import { FILE_CHUNK_BYTES, MAX_FILE_BYTES } from "../src/lib/file-transfer";
import {
  downloadPrivateDocument,
  FileTransferError,
  transferFetch,
  uploadFileThroughWebsite,
} from "../src/lib/file-transfer-client";
import { transferDiagnostic } from "../src/server/file-transfer";

const app = "https://samrat.example";
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const caseId = "33333333-3333-4333-8333-333333333333";
const fileId = "44444444-4444-4444-8444-444444444444";
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const jwt =
  [
    { alg: "HS256", typ: "JWT" },
    {
      sub: owner,
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: "authenticated",
    },
  ]
    .map((p) => Buffer.from(JSON.stringify(p)).toString("base64url"))
    .join(".") + ".dGVzdA";
const tokenFor = (subject: string) =>
  [
    { alg: "HS256", typ: "JWT" },
    {
      sub: subject,
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: "authenticated",
    },
  ]
    .map((p) => Buffer.from(JSON.stringify(p)).toString("base64url"))
    .join(".") + ".dGVzdA";

function setup(t: TestContext) {
  const env = {
    SUPABASE_INTERNAL_URL: "https://storage.example.invalid",
    SUPABASE_PUBLISHABLE_KEY: "test-public-key",
    SUPABASE_SERVICE_ROLE_KEY: "test-private-key",
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, env);
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const objects = new Map<string, Uint8Array>();
  const assets: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const browser: Array<{ path: string; method: string; size: number }> = [];
  let visibleOwner = owner;
  let preview: Record<string, unknown> | null = null;
  let failPart = -1;
  let losePartResponse = -1;
  let lost = false;
  let losePreparation = false;
  t.mock.method(console, "info", (message: string) => logs.push(message));
  t.mock.method(console, "warn", (message: string) => logs.push(message));
  const notFound = () =>
    Response.json(
      { statusCode: "404", message: "Object not found" },
      { status: 404 },
    );
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(
        url.origin,
        env.SUPABASE_INTERNAL_URL,
        "Never contact a real service in these tests",
      );
      const method = init?.method || "GET";
      if (url.pathname === "/auth/v1/user")
        return Response.json({
          id: visibleOwner,
          aud: "authenticated",
          role: "authenticated",
        });
      if (url.pathname === "/rest/v1/rpc/reserve_upload") {
        const body = JSON.parse(String(init?.body));
        assets.push({
          id: body.p_id,
          owner_user_id: body.p_user,
          storage_path: body.p_path,
          original_name: body.p_name,
          size_bytes: body.p_size,
          content_sha256: body.p_sha,
          mime_type: body.p_mime,
          created_at: new Date().toISOString(),
          consumed_case_id: null,
        });
        return Response.json(null);
      }
      if (url.pathname === "/rest/v1/storage_assets")
        return Response.json(
          assets.filter(
            (a) =>
              `eq.${a.id}` === url.searchParams.get("id") &&
              `eq.${a.owner_user_id}` === url.searchParams.get("owner_user_id"),
          ),
        );
      if (url.pathname === "/rest/v1/packet_cases")
        return Response.json(
          url.searchParams.get("owner_user_id") === `eq.${owner}`
            ? [{ id: caseId, owner_user_id: owner }]
            : [],
        );
      if (url.pathname === "/rest/v1/packet_case_files")
        return Response.json(
          preview &&
            url.searchParams.get("id") === `eq.${fileId}` &&
            url.searchParams.get("case_id") === `eq.${caseId}`
            ? [preview]
            : [],
        );
      const info = "/storage/v1/object/info/packet-files/";
      const object = "/storage/v1/object/packet-files";
      if (url.pathname.startsWith(info)) {
        const value = objects.get(
          decodeURIComponent(url.pathname.slice(info.length)),
        );
        return value ? Response.json({ size: value.length }) : notFound();
      }
      if (url.pathname === "/storage/v1/object/list/packet-files") {
        const body = JSON.parse(String(init?.body));
        const prefix = `${body.prefix}/`;
        return Response.json(
          [...objects.entries()]
            .filter(([p]) => p.startsWith(prefix))
            .map(([p, b]) => ({
              name: p.slice(prefix.length),
              metadata: { size: b.length },
            })),
        );
      }
      if (url.pathname === object && method === "DELETE") {
        const body = JSON.parse(String(init?.body));
        for (const path of body.prefixes) objects.delete(path);
        return Response.json([]);
      }
      if (url.pathname.startsWith(object + "/")) {
        const path = decodeURIComponent(url.pathname.slice(object.length + 1));
        if (method === "POST") {
          if (objects.has(path))
            return Response.json(
              { statusCode: "409", message: "Already exists" },
              { status: 409 },
            );
          objects.set(
            path,
            new Uint8Array(
              await new Response(init?.body as BodyInit).arrayBuffer(),
            ),
          );
          return Response.json({ Key: `packet-files/${path}` });
        }
        const bytes = objects.get(path);
        if (!bytes) return notFound();
        const range = new Headers(init?.headers).get("range");
        if (range) {
          const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
          return new Response(bytes.slice(Number(a), Number(b) + 1), {
            status: 206,
            headers: {
              "Content-Range": `bytes ${a}-${b}/${bytes.length}`,
              "Set-Cookie": "must-not-forward=private",
              "Content-Type": "application/pdf",
            },
          });
        }
        return new Response(bytes.slice());
      }
      throw new Error(`Unexpected upstream request: ${method} ${url.pathname}`);
    },
  );
  const fetcher = async (path: string, init?: RequestInit) => {
    assert.ok(
      path.startsWith("/api/"),
      "All browser transfers stay on the website",
    );
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${tokenFor(visibleOwner)}`);
    headers.set("Origin", app);
    const request = new Request(new URL(path, app), { ...init, headers });
    const url = new URL(request.url);
    const size =
      init?.body instanceof Blob
        ? init.body.size
        : typeof init?.body === "string"
          ? init.body.length
          : 0;
    browser.push({ path, method: request.method, size });
    if (path === "/api/uploads") {
      const response = await prepare(request);
      if (losePreparation) {
        losePreparation = false;
        throw new TypeError("Lost preparation response");
      }
      return response;
    }
    if (path === "/api/uploads/diagnostics") {
      logs.push(JSON.stringify(transferDiagnostic(await request.json())));
      return Response.json({ recorded: true });
    }
    if (url.pathname.startsWith("/api/cases/"))
      return files(request, { params: Promise.resolve({ id: caseId }) });
    const id = url.pathname.split("/").at(-1)!;
    const context = { params: Promise.resolve({ id }) };
    if (request.method === "GET") return status(request, context);
    if (request.method === "POST") return complete(request, context);
    const n = Number(url.searchParams.get("part"));
    if (n === failPart)
      return Response.json(
        { error: "Temporary interruption" },
        { status: 503 },
      );
    const response = await part(request, context);
    if (n === losePartResponse && !lost) {
      lost = true;
      throw new TypeError("Failed to fetch");
    }
    return response;
  };
  const deps = { fetcher, wait: async () => {} };
  return {
    objects,
    assets,
    logs,
    browser,
    deps,
    setOwner: (value: string) => {
      visibleOwner = value;
    },
    setFailPart: (n: number) => {
      failPart = n;
    },
    losePart: (n: number) => {
      losePartResponse = n;
    },
    losePreparation: () => {
      losePreparation = true;
    },
    attach: (asset: Record<string, unknown>) => {
      preview = { ...asset, id: fileId, storage_bucket: "packet-files" };
    },
  };
}

test("upload and preview preserve the original maximum-size 50 MiB file through bounded same-origin requests", async (t) => {
  const fixture = setup(t);
  const bytes = Buffer.alloc(MAX_FILE_BYTES, 73);
  bytes.write("%PDF-original-byte-preservation");
  const file = new File([bytes], "large.pdf", { type: "application/pdf" });
  const id = await uploadFileThroughWebsite(file, digest(bytes), fixture.deps);
  assert.equal(fixture.assets.length, 1);
  const asset = fixture.assets[0];
  assert.equal(id, asset.id);
  const stored = fixture.objects.get(String(asset.storage_path))!;
  assert.equal(stored.length, bytes.length);
  assert.equal(digest(stored), digest(bytes));
  assert.equal(
    fixture.objects.size,
    1,
    "Temporary parts were removed after finalization",
  );
  assert.equal(fixture.browser.filter((r) => r.method === "PUT").length, 100);
  assert.ok(fixture.browser.every((r) => r.size <= FILE_CHUNK_BYTES));
  fixture.attach(asset);
  const source = `/api/cases/${caseId}/files?fileId=${fileId}&content=1`;
  const blob = await downloadPrivateDocument(source, undefined, fixture.deps);
  assert.equal(blob.size, bytes.length);
  assert.equal(digest(new Uint8Array(await blob.arrayBuffer())), digest(bytes));
  const fallback = await fixture.deps.fetcher(
    `/api/cases/${caseId}/files?fileId=${fileId}`,
  );
  assert.equal(fallback.status, 200);
  assert.equal(
    (await fallback.json()).signedUrl,
    source,
    "Fallback returns the protected website URL",
  );
  const chunk = await fixture.deps.fetcher(source, {
    headers: { Range: "bytes=0-10" },
  });
  assert.equal(chunk.status, 206);
  assert.equal(chunk.headers.get("set-cookie"), null);
  assert.equal(chunk.headers.get("location"), null);
  assert.equal(chunk.headers.get("cache-control"), "private, no-store");
  assert.doesNotMatch(
    fixture.logs.join("\n"),
    /test-private-key|test-public-key|large.pdf|%PDF/,
  );
});

test("lost chunk responses retry idempotently without rewriting bytes or reserving a second upload", async (t) => {
  const f = setup(t);
  f.losePart(0);
  const bytes = Buffer.alloc(FILE_CHUNK_BYTES + 17, 11);
  const file = new File([bytes], "retry.pdf");
  await uploadFileThroughWebsite(file, digest(bytes), f.deps);
  assert.equal(f.assets.length, 1);
  assert.equal(
    f.browser.filter((r) => r.method === "PUT" && r.path.endsWith("part=0"))
      .length,
    2,
  );
  assert.equal(
    digest(f.objects.get(String(f.assets[0].storage_path))!),
    digest(bytes),
  );
});

test("a lost preparation response reuses the same reservation", async (t) => {
  const f = setup(t);
  f.losePreparation();
  const bytes = Buffer.from("original");
  await uploadFileThroughWebsite(
    new File([bytes], "prepare.pdf"),
    digest(bytes),
    f.deps,
  );
  assert.equal(f.assets.length, 1);
});

test("completed uploads can be retried safely without changing their bytes", async (t) => {
  const f = setup(t);
  const bytes = Buffer.from("original");
  const file = new File([bytes], "complete.pdf");
  const first = await uploadFileThroughWebsite(file, digest(bytes), f.deps);
  const second = await uploadFileThroughWebsite(file, digest(bytes), f.deps);
  assert.equal(second, first);
  assert.equal(f.assets.length, 1);
  assert.equal(f.browser.filter((r) => r.method === "PUT").length, 1);
});

test("a later retry resumes saved chunks instead of uploading successful parts again", async (t) => {
  const f = setup(t);
  f.setFailPart(1);
  const bytes = Buffer.alloc(FILE_CHUNK_BYTES * 2 + 29, 19);
  const file = new File([bytes], "resume.pdf");
  await assert.rejects(
    uploadFileThroughWebsite(file, digest(bytes), f.deps),
    /Temporary interruption/,
  );
  f.setFailPart(-1);
  const id = await uploadFileThroughWebsite(file, digest(bytes), f.deps);
  assert.equal(f.assets.length, 1);
  assert.equal(id, f.assets[0].id);
  assert.equal(
    f.browser.filter((r) => r.method === "PUT" && r.path.endsWith("part=0"))
      .length,
    1,
  );
  assert.equal(
    digest(f.objects.get(String(f.assets[0].storage_path))!),
    digest(bytes),
  );
});

test("wrong final checksums never create an analysis-ready file", async (t) => {
  const f = setup(t);
  const file = new File(["original bytes"], "hash.pdf");
  await assert.rejects(
    uploadFileThroughWebsite(file, "0".repeat(64), f.deps),
    /File verification failed/,
  );
  assert.equal(f.objects.has(String(f.assets[0].storage_path)), false);
});

test("another account cannot inspect, write, finalize, or preview someone else's upload", async (t) => {
  const f = setup(t);
  const bytes = Buffer.from("original bytes");
  await uploadFileThroughWebsite(
    new File([bytes], "owner.pdf"),
    digest(bytes),
    f.deps,
  );
  const asset = f.assets[0];
  f.attach(asset);
  f.setOwner(other);
  for (const method of ["GET", "PUT", "POST"]) {
    const r = await f.deps.fetcher(
      `/api/uploads/${asset.id}${method === "PUT" ? "?part=0" : ""}`,
      { method, ...(method === "PUT" ? { body: new Blob([bytes]) } : {}) },
    );
    assert.equal(r.status, 404);
  }
  const preview = await f.deps.fetcher(
    `/api/cases/${caseId}/files?fileId=${fileId}&info=1`,
  );
  assert.equal(preview.status, 404);
  assert.equal(f.objects.size, 1);
});

test("oversized chunks, invalid indexes, changed chunk bytes, and expired reservations are rejected", async (t) => {
  const f = setup(t);
  const bytes = Buffer.from("sample");
  const reserved = await f.deps.fetcher("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "part.pdf",
      size: bytes.length,
      sha256: digest(bytes),
      transport: "relay-v1",
    }),
  });
  const { id } = await reserved.json();
  const wrong = await f.deps.fetcher(`/api/uploads/${id}?part=0`, {
    method: "PUT",
    headers: { "X-Samrat-Part-Sha256": "0".repeat(64) },
    body: new Blob([bytes]),
  });
  assert.equal(wrong.status, 422);
  const large = await f.deps.fetcher(`/api/uploads/${id}?part=0`, {
    method: "PUT",
    body: new Blob([Buffer.alloc(FILE_CHUNK_BYTES + 1)]),
  });
  assert.equal(large.status, 413);
  const invalid = await f.deps.fetcher(`/api/uploads/${id}?part=1.2`, {
    method: "PUT",
    body: new Blob([bytes]),
  });
  assert.equal(invalid.status, 400);
  f.assets[0].created_at = "2020-01-01T00:00:00Z";
  assert.equal((await f.deps.fetcher(`/api/uploads/${id}`)).status, 410);
  assert.equal(f.objects.size, 0);
});

test("unauthenticated and cross-origin requests cannot prepare or transfer a file", async (t) => {
  setup(t);
  const noAuth = await prepare(
    new Request(`${app}/api/uploads`, {
      method: "POST",
      headers: { Origin: app, Authorization: "Basic unauthenticated" },
      body: "{}",
    }),
  );
  assert.equal(noAuth.status, 401);
  const crossOrigin = await prepare(
    new Request(`${app}/api/uploads`, {
      method: "POST",
      headers: {
        Origin: "https://untrusted.example",
        Authorization: `Bearer ${jwt}`,
      },
      body: "{}",
    }),
  );
  assert.equal(crossOrigin.status, 401);
});

test("download verification rejects corrupted content even when sizes and ranges agree", async () => {
  const original = Buffer.from("Original");
  const corrupt = Buffer.from("Modified");
  const fetcher = async (_path: string, init?: RequestInit) =>
    new Headers(init?.headers).has("range")
      ? new Response(corrupt, {
          status: 206,
          headers: { "Content-Range": `bytes 0-7/8` },
        })
      : Response.json({
          size: 8,
          sha256: digest(original),
          chunkSize: FILE_CHUNK_BYTES,
          mimeType: "application/pdf",
        });
  await assert.rejects(
    downloadPrivateDocument(
      `/api/cases/${caseId}/files?fileId=${fileId}&content=1`,
      undefined,
      { fetcher },
    ),
    /did not match the original/,
  );
});

test("non-retryable permission errors keep their meaning and diagnostics exclude private data", async () => {
  let calls = 0;
  const diagnostics: unknown[] = [];
  const fetcher = async (path: string, init?: RequestInit) => {
    if (path.endsWith("diagnostics")) {
      diagnostics.push(JSON.parse(String(init?.body)));
      return Response.json({ recorded: true });
    }
    calls++;
    return Response.json(
      { error: "Your session has expired. Sign in again." },
      { status: 401 },
    );
  };
  await assert.rejects(
    transferFetch(
      "/api/uploads",
      "prepare",
      { method: "POST", body: "secret-file-contents" },
      { fetcher },
    ),
    (error) => error instanceof FileTransferError && error.status === 401,
  );
  assert.equal(calls, 1);
  assert.equal(diagnostics.length, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret-file-contents/);
  assert.deepEqual(
    Object.keys(
      transferDiagnostic({
        requestId: crypto.randomUUID(),
        operation: "part",
        failure: "network",
        filename: "private.pdf",
        token: "secret",
        contents: "private",
        durationMs: 25,
      }),
    ),
    ["scope", "requestId", "operation", "failure", "status", "durationMs"],
  );
});

test("a stalled transfer is cancelled, retried only within its limit, and recorded as a timeout", async () => {
  const signals: AbortSignal[] = [];
  const events: Array<Record<string, unknown>> = [];
  const fetcher = async (path: string, init?: RequestInit) => {
    if (path.endsWith("diagnostics")) {
      events.push(JSON.parse(String(init?.body)));
      return Response.json({ recorded: true });
    }
    signals.push(init!.signal!);
    return new Promise<Response>(() => {});
  };
  await assert.rejects(
    transferFetch(
      "/api/uploads",
      "prepare",
      {},
      { fetcher, timeoutMs: 10, wait: async () => {} },
    ),
    /took too long/,
  );
  assert.equal(signals.length, 3);
  assert.ok(signals.every((s) => s.aborted));
  assert.ok(events.every((e) => e.failure === "timeout"));
});

test("document ranges remain bounded and malformed ranges never reach storage", async (t) => {
  const f = setup(t);
  const bytes = Buffer.alloc(FILE_CHUNK_BYTES + 10, 7);
  await uploadFileThroughWebsite(
    new File([bytes], "ranges.pdf"),
    digest(bytes),
    f.deps,
  );
  f.attach(f.assets[0]);
  const source = `/api/cases/${caseId}/files?fileId=${fileId}&content=1`;
  for (const range of [
    `bytes=0-${FILE_CHUNK_BYTES}`,
    "bytes=-1-4",
    "bytes=0-2,4-6",
    `bytes=0-${bytes.length}`,
    "bytes=4-1",
  ]) {
    assert.equal(
      (await f.deps.fetcher(source, { headers: { Range: range } })).status,
      416,
    );
  }
});

test("the diagnostics endpoint logs only its explicit safe fields", async (t) => {
  const f = setup(t);
  const request = new Request(`${app}/api/uploads/diagnostics`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Origin: app,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      operation: "part",
      failure: "network",
      filename: "private.pdf",
      password: "secret-password",
      durationMs: 7,
    }),
  });
  assert.equal((await diagnostics(request)).status, 200);
  assert.doesNotMatch(f.logs.join("\n"), /private.pdf|secret-password/);
});
