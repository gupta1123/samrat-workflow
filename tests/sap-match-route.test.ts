import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { GET } from "../src/app/api/cases/[id]/sap-match/route";

const userId = "a1111111-1111-4111-8111-111111111111";
const caseId = "f8753e44-f8ac-412a-b507-58b7e79836f3";
const posting = {
  kind: "AP",
  status: "posted",
  sap_env: "test",
  sap_docnum: "848",
  error: null,
  created_at: "2026-10-01",
  updated_at: "2026-10-01",
};
const jwt =
  [
    { alg: "HS256", typ: "JWT" },
    {
      sub: userId,
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: "authenticated",
    },
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".") + ".dGVzdA";

function setup(
  t: TestContext,
  options: {
    postings?: (typeof posting)[];
    ownsCase?: boolean;
    validSession?: boolean;
    environment?: string;
  } = {},
) {
  const env = {
    SUPABASE_INTERNAL_URL: "https://db.example.invalid",
    SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    SAP_API_ENV: options.environment ?? "test",
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const calls: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(
        url.origin,
        env.SUPABASE_INTERNAL_URL,
        "Tests must not contact real services",
      );
      calls.push(url.pathname);
      assert.equal(
        init?.method ?? "GET",
        "GET",
        "Reading status must not write anything",
      );
      if (url.pathname === "/auth/v1/user") {
        return options.validSession === false
          ? Response.json({ message: "Invalid token" }, { status: 401 })
          : Response.json({
              id: userId,
              aud: "authenticated",
              role: "authenticated",
            });
      }
      assert.equal(url.searchParams.get("owner_user_id"), `eq.${userId}`);
      if (url.pathname === "/rest/v1/packet_cases") {
        assert.equal(url.searchParams.get("id"), `eq.${caseId}`);
        return Response.json(
          options.ownsCase === false
            ? []
            : [{ id: caseId, status: "accepted", deleted_at: null }],
        );
      }
      assert.equal(url.searchParams.get("case_id"), `eq.${caseId}`);
      if (url.pathname === "/rest/v1/sap_postings")
        return Response.json(options.postings ?? [posting]);
      if (url.pathname === "/rest/v1/sap_match_jobs") {
        return Response.json([
          {
            status: "running",
            stage: "Reading SAP documents",
            error: null,
            attempt_count: 1,
            requested_at: "2026-10-04",
            finished_at: null,
            result: null,
          },
        ]);
      }
      throw new Error(`Unexpected API call: ${url.pathname}`);
    },
  );
  return calls;
}

async function read(refresh = false) {
  return GET(
    new Request(
      `https://app.example.invalid/api/cases/${caseId}/sap-match${refresh ? "?refresh=1" : ""}`,
      {
        headers: { authorization: `Bearer ${jwt}` },
      },
    ),
    { params: Promise.resolve({ id: caseId }) },
  );
}

for (const refresh of [false, true]) {
  test(`posted invoice returns immediately without reading or enqueueing a match (refresh=${refresh})`, async (t) => {
    const calls = setup(t);
    const result = await read(refresh);
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal(body.postable, false);
    assert.equal(body.reason, "Posted as A/P invoice 848");
    assert.equal(body.matchJob, undefined);
    assert.equal(body.postings[0].sap_docnum, "848");
    assert.deepEqual(calls, [
      "/auth/v1/user",
      "/rest/v1/packet_cases",
      "/rest/v1/sap_postings",
    ]);
  });
}

test("posted invoice in the live company also returns without starting test matching", async (t) => {
  const calls = setup(t, {
    environment: "live",
    postings: [{ ...posting, sap_env: "live" }],
  });
  const result = await read();
  assert.equal(result.status, 200);
  assert.equal((await result.json()).reason, "Posted as A/P invoice 848");
  assert.equal(calls.length, 3);
});

for (const [name, postings] of [
  ["unposted case", []],
  ["prepared draft", [{ ...posting, status: "prepared" }]],
  ["posted receipt", [{ ...posting, kind: "GRN" }]],
  ["invoice in another SAP company", [{ ...posting, sap_env: "live" }]],
] as const) {
  test(`${name} still reads its SAP matching job`, async (t) => {
    const calls = setup(t, { postings: [...postings] });
    const result = await read();
    assert.equal(result.status, 200);
    assert.equal((await result.json()).matchJob.status, "running");
    assert.equal(calls.at(-1), "/rest/v1/sap_match_jobs");
  });
}

test("the posted shortcut still checks case ownership", async (t) => {
  const calls = setup(t, { ownsCase: false });
  const result = await read();
  assert.equal(result.status, 404);
  assert.deepEqual(calls, ["/auth/v1/user", "/rest/v1/packet_cases"]);
});

test("the posted shortcut still requires a valid session", async (t) => {
  const calls = setup(t, { validSession: false });
  const result = await read();
  assert.equal(result.status, 401);
  assert.deepEqual(calls, ["/auth/v1/user"]);
});
