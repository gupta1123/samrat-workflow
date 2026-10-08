import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { withTestServiceLayer } from "../src/server/sap/service-layer";

function setup(
  t: TestContext,
  read: (url: URL) => { statusCode: number; data: unknown },
) {
  const values = {
    SAP_SL_TEST_BASE_URL: "https://sap.example.test/b1s/v1",
    SAP_SL_TEST_COMPANY_DB: "TEST",
    SAP_SL_TEST_USERNAME: "test",
    SAP_SL_TEST_PASSWORD: "test",
    QUOTAGUARDSTATIC_URL: "",
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  const dispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const pool = agent.get("https://sap.example.test");
  pool
    .intercept({ path: "/b1s/v1/Login", method: "POST" })
    .reply(200, { SessionId: "test-session" });
  pool.intercept({ path: "/b1s/v1/Logout", method: "POST" }).reply(200, {});
  pool
    .intercept({ path: () => true, method: "GET" })
    .reply((options) => read(new URL(options.path, "https://sap.example.test")))
    .persist();
  t.after(async () => {
    setGlobalDispatcher(dispatcher);
    await agent.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("supplier discovery queries literal invoice/e-way references across BPs, pages every result and never queries vehicle/LR", async (t) => {
  const calls: URL[] = [];
  setup(t, (url) => {
    calls.push(url);
    const skip = Number(url.searchParams.get("$skip"));
    return {
      statusCode: 200,
      data: {
        value:
          skip === 0 ? [{ DocEntry: 1 }] : skip === 1 ? [{ DocEntry: 2 }] : [],
      },
    };
  });
  const rows = await withTestServiceLayer((client) =>
    client.findOpenReceiptDocumentsForInvoice({
      invoiceNumber: "INV'701",
      eWayBill: "187001234567",
      invoiceRefField: "U_INV",
      eWayBillField: "U_EWAY",
      lorryReceipt: "LR-1",
      vehicles: ["AP01AA0001"],
      vehicleField: "U_VEH",
      lorryReceiptField: "U_LR",
    }),
  );
  assert.deepEqual(
    rows.map((row) => row.DocEntry),
    [1, 2],
  );
  assert.ok(
    calls.some((url) =>
      url.searchParams.get("$filter")?.includes("NumAtCard eq 'INV''701'"),
    ),
  );
  assert.ok(
    calls.some((url) =>
      url.searchParams.get("$filter")?.includes("U_EWAY eq '187001234567'"),
    ),
  );
  assert.ok(calls.some((url) => url.searchParams.get("$skip") === "1"));
  for (const url of calls) {
    const filter = url.searchParams.get("$filter") ?? "";
    assert.equal(filter.includes("CardCode"), false);
    assert.equal(filter.includes("U_VEH"), false);
    assert.equal(filter.includes("U_LR"), false);
  }
});

test("a failed identifier query cannot prove a unique supplier from the remaining queries", async (t) => {
  setup(t, (url) =>
    url.searchParams.get("$filter")?.includes("U_EWAY")
      ? {
          statusCode: 500,
          data: { error: { message: { value: "Unavailable" } } },
        }
      : { statusCode: 200, data: { value: [] } },
  );
  await assert.rejects(
    withTestServiceLayer((client) =>
      client.findOpenReceiptDocumentsForInvoice({
        invoiceNumber: "INV-701",
        eWayBill: "187001234567",
        eWayBillField: "U_EWAY",
        lorryReceipt: null,
        vehicles: [],
      }),
    ),
    /HTTP 500/,
  );
});

test("a capped cross-supplier search is rejected rather than selecting from partial results", async (t) => {
  setup(t, (url) => {
    const skip = Number(url.searchParams.get("$skip"));
    return {
      statusCode: 200,
      data: {
        value: Array.from({ length: 100 }, (_, i) => ({
          DocEntry: skip + i + 1,
        })),
      },
    };
  });
  await assert.rejects(
    withTestServiceLayer((client) =>
      client.findOpenReceiptDocumentsForInvoice({
        invoiceNumber: "INV-701",
        eWayBill: null,
        lorryReceipt: null,
        vehicles: [],
      }),
    ),
    /read limit/,
  );
});
