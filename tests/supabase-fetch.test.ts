import assert from "node:assert/strict";
import { test } from "node:test";
import { createSupabaseFetch } from "../src/lib/supabase/fetch";

test("fetch preserves status, headers and the complete JSON response", async () => {
  const fetch = createSupabaseFetch(100, async () =>
    Response.json(
      { complete: true },
      { status: 401, headers: { "x-test": "yes" } },
    ),
  );
  const response = await fetch("https://example.invalid");
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("x-test"), "yes");
  assert.deepEqual(await response.json(), { complete: true });
});

test("a bodyless response remains bodyless", async () => {
  const response = await createSupabaseFetch(
    100,
    async () => new Response(null, { status: 204 }),
  )("https://example.invalid");
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("a Request's cancellation signal is honoured before dispatch", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const fetch = createSupabaseFetch(100, async () => {
    called = true;
    return Response.json({});
  });
  await assert.rejects(
    fetch(
      new Request("https://example.invalid", { signal: controller.signal }),
    ),
    { name: "AbortError" },
  );
  assert.equal(called, false);
});

test("the deadline aborts stalled response bodies, not just connection setup", async () => {
  let aborted = false;
  const fetch = createSupabaseFetch(
    15,
    async (_, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            init!.signal!.addEventListener("abort", () => {
              aborted = true;
              controller.error(init!.signal!.reason);
            });
          },
        }),
      ),
  );
  await assert.rejects(fetch("https://example.invalid"), {
    name: "TimeoutError",
  });
  assert.equal(aborted, true);
});
