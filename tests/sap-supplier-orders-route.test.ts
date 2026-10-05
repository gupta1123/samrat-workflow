import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { GET } from "../src/app/api/cases/[id]/sap-match/purchase-orders/route";
import { clearSapCache } from "../src/server/sap/client";
import { matchFixture } from "./sap-posted-fixture";

const user = "a1111111-1111-4111-8111-111111111111";
const id = "f8753e44-f8ac-412a-b507-58b7e79836f3";
const jwt =
  [
    { alg: "HS256", typ: "JWT" },
    {
      sub: user,
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: "authenticated",
    },
  ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".") + ".dGVzdA";

function setup(t: TestContext, owns = true) {
  const env: Record<string, string | undefined> = {
    SUPABASE_INTERNAL_URL: "https://db.example.invalid",
    SUPABASE_PUBLISHABLE_KEY: "test-key",
    SUPABASE_SERVICE_ROLE_KEY: "test-secret",
    SAP_API_ENV: "test",
    SAP_TEST_BASE_URL: "https://sap.example.invalid",
    SAP_TEST_USERNAME: "test",
    SAP_TEST_PASSWORD: "test",
    SAP_SL_TEST_BASE_URL: undefined,
    QUOTAGUARDSTATIC_URL: undefined,
  };
  const before = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearSapCache();
  });
  const reads: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, env.SUPABASE_INTERNAL_URL);
      assert.equal(init?.method ?? "GET", "GET");
      if (url.pathname === "/auth/v1/user")
        return Response.json({
          id: user,
          aud: "authenticated",
          role: "authenticated",
        });
      assert.equal(url.searchParams.get("owner_user_id"), `eq.${user}`);
      reads.push(url.pathname);
      if (url.pathname === "/rest/v1/packet_cases")
        return Response.json(
          owns ? { id, owner_user_id: user, deleted_at: null } : null,
        );
      if (url.pathname === "/rest/v1/sap_match_jobs")
        return Response.json({ result: { ...matchFixture, available: true } });
      if (url.pathname === "/rest/v1/sap_postings") return Response.json(null);
      throw new Error(`Unexpected query: ${url.pathname}`);
    },
  );
  const previousDispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  t.after(async () => {
    setGlobalDispatcher(previousDispatcher);
    await agent.close();
  });
  return { agent, reads };
}
function request() {
  return new Request(
    `https://app.example.invalid/api/cases/${id}/sap-match/purchase-orders?cardCode=OTHER`,
    { headers: { authorization: `Bearer ${jwt}` } },
  );
}

test("PO GET reads an owned case, ignores caller supplier overrides, and returns a partial source explicitly", async (t) => {
  const { agent, reads } = setup(t);
  agent
    .get("https://sap.example.invalid")
    .intercept({ path: "/SPAPI/OpenPO", method: "GET" })
    .reply(200, {
      success: true,
      data: [
        {
          DocNum: 100255,
          "BP Code": "TSPL001",
          ItemCode: "TTR027",
          Quantity: 300,
        },
        {
          DocNum: 100300,
          "BP Code": "OTHER",
          ItemCode: "TTR027",
          Quantity: 300,
        },
      ],
    });
  const response = await GET(request(), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.vendor.cardCode, "TSPL001");
  assert.equal(body.orders.length, 1);
  assert.equal(body.orders[0].number, "100255");
  assert.match(body.warnings[0], /Purchase Orders unavailable/);
  assert.equal(reads.length, 3);
  agent.assertNoPendingInterceptors();
});
test("an unowned case cannot read match data or supplier POs", async (t) => {
  const { reads } = setup(t, false);
  const response = await GET(request(), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 404);
  assert.deepEqual(reads, ["/rest/v1/packet_cases"]);
});
