import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { handleAuthProxy } from "../src/server/auth-proxy";
import { createSupabaseBrowserFetch } from "../src/lib/supabase/browser-fetch";
import { signInErrorMessage } from "../src/lib/supabase/auth-error";

const app = "https://samrat.example";
const upstream = "https://project.example";
const key = "configured-publishable-key";
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  aud: "authenticated",
  role: "authenticated",
};
const tokens = (suffix = "new") => ({
  access_token: `access-${suffix}`,
  refresh_token: `refresh-${suffix}`,
  expires_in: 3600,
  token_type: "bearer",
  user,
});
function request(
  path = "token?grant_type=password",
  body: unknown = { email: "test@example.invalid", password: "mock-password" },
  extra?: Record<string, string>,
) {
  return new Request(`${app}/api/auth/${path}`, {
    method: "POST",
    headers: { origin: app, "content-type": "application/json", ...extra },
    body: JSON.stringify(body),
  });
}
const json = (body: unknown, status = 200) => Response.json(body, { status });

test("sign-in uses a fixed destination and configured public key, preserves SDK tokens and never forwards upstream cookies", async () => {
  const logs: unknown[] = [];
  const response = await handleAuthProxy(
    request(
      "token?grant_type=password&redirect_to=https://evil.invalid",
      {
        email: "test@example.invalid",
        password: "mock-password",
        target: "https://evil.invalid",
        admin: true,
      },
      { apikey: "attacker-key", authorization: "Bearer attacker-key" },
    ),
    ["token"],
    {
      url: upstream,
      key,
      log: (e) => logs.push(e),
      fetcher: async (input, init) => {
        assert.equal(
          String(input),
          `${upstream}/auth/v1/token?grant_type=password`,
        );
        assert.equal(new Headers(init?.headers).get("apikey"), key);
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          `Bearer ${key}`,
        );
        assert.equal(init?.redirect, "error");
        assert.deepEqual(JSON.parse(String(init?.body)), {
          email: "test@example.invalid",
          password: "mock-password",
        });
        const r = json(tokens());
        r.headers.set("set-cookie", "upstream-only=secret");
        return r;
      },
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), tokens());
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.doesNotMatch(
    JSON.stringify(logs),
    /mock-password|test@example|access-new|refresh-new|configured-publishable/,
  );
});

test("the real Supabase SDK signs in and renews through the same-origin relay", async () => {
  const browserPaths: string[] = [];
  const grants: string[] = [];
  const browserFetch: typeof fetch = async (input, init) => {
    const r = new Request(input, init);
    browserPaths.push(new URL(r.url).origin + new URL(r.url).pathname);
    return handleAuthProxy(
      r,
      new URL(r.url).pathname.replace("/api/auth/", "").split("/"),
      {
        url: upstream,
        key,
        fetcher: async (target, options) => {
          const grant = new URL(String(target)).searchParams.get("grant_type")!;
          grants.push(grant);
          if (grant === "refresh_token")
            assert.deepEqual(JSON.parse(String(options?.body)), {
              refresh_token: "refresh-new",
            });
          return json(tokens(grant));
        },
      },
    );
  };
  const client = createClient(upstream, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: createSupabaseBrowserFetch(upstream, app, browserFetch) },
  });
  const signedIn = await client.auth.signInWithPassword({
    email: "test@example.invalid",
    password: "mock-password",
  });
  assert.equal(signedIn.error, null);
  const refreshed = await client.auth.refreshSession({
    refresh_token: "refresh-new",
  });
  assert.equal(refreshed.error, null);
  assert.equal(refreshed.data.session?.access_token, "access-refresh_token");
  assert.deepEqual(grants, ["password", "refresh_token"]);
  assert.deepEqual(browserPaths, [
    `${app}/api/auth/token`,
    `${app}/api/auth/token`,
  ]);
});

test("untrusted origins, admin paths, arbitrary grants, methods and oversized input cannot reach upstream", async () => {
  let calls = 0;
  const deps = {
    url: upstream,
    key,
    fetcher: async () => {
      calls++;
      return json(tokens());
    },
  };
  assert.equal(
    (
      await handleAuthProxy(
        request(undefined, undefined, { origin: "https://evil.invalid" }),
        ["token"],
        deps,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleAuthProxy(
        request(undefined, undefined, { "sec-fetch-site": "cross-site" }),
        ["token"],
        deps,
      )
    ).status,
    403,
  );
  for (const path of [
    ["admin", "users"],
    ["..", "token"],
    ["signup"],
    ["https://evil.invalid"],
  ]) {
    assert.equal((await handleAuthProxy(request(), path, deps)).status, 404);
  }
  assert.equal(
    (
      await handleAuthProxy(
        request("token?grant_type=client_credentials"),
        ["token"],
        deps,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await handleAuthProxy(
        new Request(`${app}/api/auth/token?grant_type=password`),
        ["token"],
        deps,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await handleAuthProxy(
        request(undefined, { email: "x", password: "x".repeat(20_000) }),
        ["token"],
        deps,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await handleAuthProxy(
        request(undefined, { password: "missing-email" }),
        ["token"],
        deps,
      )
    ).status,
    400,
  );
  assert.equal(calls, 0);
});

test("credential, expired-refresh-token and rate-limit responses retain their status and error codes", async () => {
  for (const [status, code] of [
    [400, "invalid_credentials"],
    [400, "refresh_token_not_found"],
    [429, "over_request_rate_limit"],
  ] as const) {
    const response = await handleAuthProxy(request(), ["token"], {
      url: upstream,
      key,
      fetcher: async () =>
        json({ code, msg: "Auth rejected the request" }, status),
    });
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
    assert.equal(response.headers.get("x-supabase-api-version"), "2024-01-01");
  }
});

test("upstream outages and malformed success responses get safe messages and diagnostic references", async () => {
  for (const raw of [
    new Response("sensitive upstream debug text", { status: 502 }),
    json({ wrong: true }),
    new Response("<html>bad gateway</html>"),
  ]) {
    const logs: unknown[] = [];
    const response = await handleAuthProxy(request(), ["token"], {
      url: upstream,
      key,
      log: (e) => logs.push(e),
      fetcher: async () => raw,
    });
    assert.ok([502, 503].includes(response.status));
    assert.match((await response.json()).msg, /Reference:/);
    assert.doesNotMatch(
      JSON.stringify(logs),
      /sensitive|mock-password|test@example/,
    );
  }
});

test("timeout covers a response whose headers arrive but whose JSON body stalls", async () => {
  let aborted = false;
  const logs: Array<{ outcome: string }> = [];
  const response = await handleAuthProxy(request(), ["token"], {
    url: upstream,
    key,
    timeoutMs: 15,
    log: (e) => logs.push(e),
    fetcher: async (_, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"access_token":'));
            init!.signal!.addEventListener("abort", () => {
              aborted = true;
              controller.error(init!.signal!.reason);
            });
          },
        }),
      ),
  });
  assert.equal(response.status, 504);
  assert.equal(aborted, true);
  assert.equal(logs[0].outcome, "timeout");
});

test("user and logout relay the user's bearer token; JWKS uses only the configured key", async () => {
  for (const [path, method] of [
    ["user", "GET"],
    ["logout", "POST"],
    [".well-known/jwks.json", "GET"],
  ]) {
    const response = await handleAuthProxy(
      new Request(`${app}/api/auth/${path}`, {
        method,
        headers: { authorization: "Bearer user-jwt", origin: app },
      }),
      path.split("/"),
      {
        url: upstream,
        key,
        fetcher: async (_, init) => {
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            `Bearer ${path.includes("jwks") ? key : "user-jwt"}`,
          );
          return path === "logout"
            ? new Response(null, { status: 204 })
            : json({ keys: [], user });
        },
      },
    );
    assert.equal(response.status, path === "logout" ? 204 : 200);
  }
});

test("browser auth connection errors report metadata only, while storage requests retain their destination", async () => {
  const calls: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const r = new Request(input, init);
    calls.push(r);
    if (new URL(r.url).pathname === "/api/auth/token")
      throw new TypeError("Failed to fetch mock-secret");
    return new Response(null, { status: 204 });
  };
  const fetch = createSupabaseBrowserFetch(upstream, app, fetcher);
  await assert.rejects(
    fetch(`${upstream}/auth/v1/token?grant_type=password`, {
      method: "POST",
      body: "password=mock-secret",
    }),
    /Failed to fetch/,
  );
  assert.equal(calls[0].url, `${app}/api/auth/token?grant_type=password`);
  assert.equal(calls[1].url, `${app}/api/auth/diagnostics`);
  const diagnostic = await calls[1].json();
  assert.equal(diagnostic.operation, "signin");
  assert.equal(diagnostic.failure, "network");
  assert.doesNotMatch(
    JSON.stringify(diagnostic),
    /mock-secret|password=|email|token/,
  );
  await fetch(`${upstream}/storage/v1/object/packet-files/example`, {
    method: "POST",
    body: "file",
  });
  assert.equal(
    calls[2].url,
    `${upstream}/storage/v1/object/packet-files/example`,
  );
});

test("the diagnostics endpoint discards extra sensitive fields and rejects invalid metadata", async () => {
  const logs: unknown[] = [];
  const body = {
    requestId: crypto.randomUUID(),
    operation: "signin",
    failure: "network",
    durationMs: 10,
    password: "must-not-log",
    email: "must-not-log",
    token: "must-not-log",
  };
  const result = await handleAuthProxy(
    request("diagnostics", body),
    ["diagnostics"],
    { log: (e) => logs.push(e) },
  );
  assert.equal(result.status, 204);
  assert.doesNotMatch(
    JSON.stringify(logs),
    /must-not-log|password|email|token/,
  );
  assert.equal(
    (
      await handleAuthProxy(
        request("diagnostics", { ...body, operation: "unexpected" }),
        ["diagnostics"],
        {},
      )
    ).status,
    400,
  );
});

test("login messages distinguish connection and rate-limit failures from wrong credentials", () => {
  assert.match(
    signInErrorMessage({ status: 0, message: "Failed to fetch" }),
    /connection to Samrat/,
  );
  assert.match(signInErrorMessage({ status: 429 }), /Too many/);
  assert.equal(
    signInErrorMessage({ status: 400, message: "Invalid login credentials" }),
    "Invalid login credentials",
  );
});
