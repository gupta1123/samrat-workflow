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

function setup(t: TestContext, owns = true, service = false) {
  const env: Record<string, string | undefined> = {
    SUPABASE_INTERNAL_URL: "https://db.example.invalid",
    SUPABASE_PUBLISHABLE_KEY: "test-key",
    SUPABASE_SERVICE_ROLE_KEY: "test-secret",
    SAP_API_ENV: "test",
    SAP_TEST_BASE_URL: "https://sap.example.invalid",
    SAP_TEST_USERNAME: "test",
    SAP_TEST_PASSWORD: "test",
    SAP_SL_TEST_BASE_URL: service
      ? "https://sl.example.invalid/b1s/v1"
      : undefined,
    SAP_SL_TEST_COMPANY_DB: service ? "test" : undefined,
    SAP_SL_TEST_USERNAME: service ? "test" : undefined,
    SAP_SL_TEST_PASSWORD: service ? "test" : undefined,
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
function request(references = false) {
  return new Request(
    `https://app.example.invalid/api/cases/${id}/sap-match/purchase-orders?cardCode=OTHER${references ? "&invoiceReferences=1" : ""}`,
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

test("invoice reference GET uses the owned supplier and follows closed GRPO and AP base links", async (t) => {
  const { agent } = setup(t, true, true);
  const pool = agent.get("https://sl.example.invalid");
  pool
    .intercept({ path: "/b1s/v1/Login", method: "POST" })
    .reply(200, { SessionId: "test-session" });
  pool.intercept({ path: "/b1s/v1/Logout", method: "POST" }).reply(200, {});
  pool
    .intercept({
      path: (path) =>
        path.startsWith("/b1s/v1/$crossjoin(PurchaseDeliveryNotes,"),
      method: "GET",
    })
    .reply(200, (options) => {
      const url = new URL(options.path, "https://sl.example.invalid");
      assert.match(
        url.searchParams.get("$filter") ?? "",
        /CardCode eq 'TSPL001'/,
      );
      assert.doesNotMatch(
        url.searchParams.get("$filter") ?? "",
        /DocumentStatus/,
      );
      return {
        value:
          url.searchParams.get("$skip") === "0"
            ? [
                {
                  PurchaseDeliveryNotes: {
                    CardCode: "TSPL001",
                    Cancelled: "tNO",
                    DocEntry: 99,
                    NumAtCard: "INV-1",
                  },
                  "PurchaseDeliveryNotes/DocumentLines": {
                    LineNum: 0,
                    BaseType: 22,
                    BaseEntry: 12,
                  },
                },
              ]
            : [],
      };
    })
    .persist();
  pool
    .intercept({
      path: (path) => path.startsWith("/b1s/v1/$crossjoin(PurchaseInvoices,"),
      method: "GET",
    })
    .reply(200, (options) => {
      const url = new URL(options.path, "https://sl.example.invalid");
      return {
        value:
          url.searchParams.get("$skip") === "0"
            ? [
                {
                  PurchaseInvoices: {
                    DocEntry: 999,
                    CardCode: "TSPL001",
                    Cancelled: "tNO",
                    NumAtCard: "INV-2",
                  },
                  "PurchaseInvoices/DocumentLines": {
                    LineNum: 0,
                    BaseType: 20,
                    BaseEntry: 99,
                    BaseLine: 0,
                  },
                },
              ]
            : [],
      };
    })
    .persist();
  const response = await GET(request(true), {
    params: Promise.resolve({ id }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.invoicesByPo, { "12": ["INV-1", "INV-2"] });
  assert.equal(body.lookup, "complete");
  assert.deepEqual(body.warnings, []);
  agent.assertNoPendingInterceptors();
});

test("invoice reference GET rejects unowned cases before any SAP read", async (t) => {
  const { reads } = setup(t, false);
  const response = await GET(request(true), {
    params: Promise.resolve({ id }),
  });
  assert.equal(response.status, 404);
  assert.deepEqual(reads, ["/rest/v1/packet_cases"]);
});

test("a failed continuation preserves retrieved invoice links and marks history partial", async (t) => {
  const { agent } = setup(t, true, true);
  const pool = agent.get("https://sl.example.invalid");
  pool
    .intercept({ path: "/b1s/v1/Login", method: "POST" })
    .reply(200, { SessionId: "test-session" });
  pool.intercept({ path: "/b1s/v1/Logout", method: "POST" }).reply(200, {});
  pool
    .intercept({
      path: (path) =>
        path.includes("$crossjoin(PurchaseDeliveryNotes,") &&
        new URL(path, "https://sl.example.invalid").searchParams.get(
          "$skip",
        ) === "0",
      method: "GET",
    })
    .reply(200, {
      value: [
        {
          PurchaseDeliveryNotes: {
            DocEntry: 99,
            CardCode: "TSPL001",
            Cancelled: "N",
            NumAtCard: "INV-1",
          },
          "PurchaseDeliveryNotes/DocumentLines": {
            LineNum: 0,
            BaseType: 22,
            BaseEntry: 12,
          },
        },
      ],
    });
  pool
    .intercept({
      path: (path) =>
        path.includes("$crossjoin(PurchaseDeliveryNotes,") &&
        new URL(path, "https://sl.example.invalid").searchParams.get(
          "$skip",
        ) === "1",
      method: "GET",
    })
    .reply(500, {});
  pool
    .intercept({
      path: (path) => path.includes("$crossjoin(PurchaseInvoices,"),
      method: "GET",
    })
    .reply(200, { value: [] });
  const response = await GET(request(true), {
    params: Promise.resolve({ id }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.invoicesByPo, { "12": ["INV-1"] });
  assert.equal(body.lookup, "partial");
  assert.match(body.warnings[0], /history partially loaded/);
  agent.assertNoPendingInterceptors();
});
