import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import type { CaseDoc } from "../src/types/pipeline";
import { serializeFieldsWithLineItems } from "../src/server/line-items";
import { computeCaseMatch } from "../src/server/sap/match-data";
import { withSapServiceLayer } from "../src/server/sap/service-layer";
import {
  discardCaseSapReadAhead,
  startCaseSapReadAhead,
  takeCaseSapReadAhead,
} from "../src/server/sap/case-read-ahead";

const row = {
  id: "read-ahead-case",
  owner_user_id: "owner",
  created_at: "2026-01-01",
  invoice_number: "INV-1",
  po_number: "",
};
const document: CaseDoc = {
  id: "source-invoice",
  type: "Tax Invoice",
  title: "Service invoice",
  pages: 1,
  sourceFileName: "invoice.pdf",
  sourcePageNumbers: [1],
  md: "Aster monthly consulting INV-1 1000",
  fields: {
    invoiceNumber: "INV-1",
    vendorName: "Aster",
    supplierGstin: "27ABCDE1234F1Z5",
    totalTaxableAmount: "1000",
  },
  supplyNature: {
    kind: "services",
    evidence: [{ sourcePage: 1, quote: "Monthly consulting" }],
  },
  lineItems: [
    {
      description: "Monthly consulting",
      quantity: "1",
      rate: "1000",
      taxableAmount: "1000",
    },
  ],
  tableCoverage: {
    status: "complete",
    rows: [
      {
        sourceFileName: "invoice.pdf",
        pageNumber: 1,
        quote: "Monthly consulting 1 1000",
      },
    ],
    evidence: {
      sourceFileName: "invoice.pdf",
      pageNumber: 1,
      quote: "Description Quantity Amount",
    },
  },
};
function database() {
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          resolve({
            error: null,
            data:
              table === "packet_documents"
                ? [
                    {
                      client_document_id: document.id,
                      document_type: document.type,
                      extracted_fields: serializeFieldsWithLineItems(document),
                      source_file_name: document.sourceFileName,
                    },
                  ]
                : [],
          }),
      };
      return builder;
    },
  } as never;
}
function setup(t: TestContext) {
  const values = {
    SAP_API_ENV: "test",
    SAP_LIVE_CASES_FROM: "",
    SAP_MATCH_READ_AHEAD_ENABLED: "true",
    SAP_SL_TEST_BASE_URL: "https://sap.example.test/b1s/v1",
    SAP_SL_TEST_COMPANY_DB: "TEST",
    SAP_SL_TEST_USERNAME: "fixture",
    SAP_SL_TEST_PASSWORD: "fixture",
    SAP_SL_LIVE_BASE_URL: "https://sap.example.test/b1s/v1",
    SAP_SL_LIVE_COMPANY_DB: "LIVE",
    SAP_SL_LIVE_USERNAME: "fixture",
    SAP_SL_LIVE_PASSWORD: "fixture",
    NEXT_PUBLIC_SUPABASE_URL: "https://database.example.test",
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
  const calls: string[] = [];
  const control = { failReads: false };
  pool
    .intercept({ path: () => true, method: "POST" })
    .reply((options) => {
      const path = new URL(options.path, "https://sap.example.test").pathname;
      calls.push(`POST ${path}`);
      assert.ok(
        path.endsWith("/Login") || path.endsWith("/Logout"),
        "Preparation must never issue a financial write",
      );
      return {
        statusCode: 200,
        data: JSON.stringify(
          path.endsWith("/Login") ? { SessionId: "fixture" } : {},
        ),
      };
    })
    .persist();
  pool
    .intercept({ path: () => true, method: "GET" })
    .reply((options) => {
      const url = new URL(options.path, "https://sap.example.test");
      calls.push(`GET ${url.pathname}`);
      if (control.failReads)
        return {
          statusCode: 503,
          data: JSON.stringify({
            error: { message: { value: "Unavailable" } },
          }),
        };
      return {
        statusCode: 200,
        data: JSON.stringify({
          value: url.pathname.endsWith("BusinessPartners")
            ? [
                {
                  CardCode: "V1",
                  CardName: "Aster",
                  BPAddresses: [{ GSTIN: "27ABCDE1234F1Z5" }],
                },
              ]
            : [],
        }),
      };
    })
    .persist();
  t.after(async () => {
    discardCaseSapReadAhead(row.id);
    setGlobalDispatcher(dispatcher);
    await agent.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return { calls, control };
}

test("source preparation is invisible until analysis commits, then matches using only read-only SAP requests", async (t) => {
  const { calls } = setup(t);
  const db = database();
  const handle = startCaseSapReadAhead({
    db,
    caseRow: row,
    documents: [document],
  })!;
  await handle.finished;
  assert.equal(takeCaseSapReadAhead(row, "test"), undefined);
  assert.ok(calls.includes("GET /b1s/v1/PurchaseOrders"));
  handle.commit();
  const prepared = takeCaseSapReadAhead(row, "test")!;
  assert.ok(prepared);
  try {
    const result = await withSapServiceLayer(
      (client) =>
        computeCaseMatch({
          db,
          client,
          caseRow: {
            ...row,
            processing_meta: {
              invoiceAssemblies: [
                {
                  invoiceNumber: "INV-1",
                  reason: "One verified billing page",
                  documents: [
                    {
                      docId: document.id,
                      role: "billing",
                      duplicateOfDocId: null,
                    },
                  ],
                  fieldSources: Object.keys(document.fields).map((field) => ({
                    field,
                    docId: document.id,
                  })),
                },
              ],
            },
          },
          reads: prepared.reads,
        }),
      "test",
    );
    assert.equal(result.available, true);
    if (result.available) assert.ok(result.invoice.fieldSources?.length);
    assert.ok(prepared.reusedReads() >= 2);
    assert.equal(
      calls.filter((call) => call === "GET /b1s/v1/PurchaseOrders").length,
      1,
    );
    assert.equal(
      calls.filter((call) => call === "GET /b1s/v1/PurchaseInvoices").length,
      2,
    );
    assert.equal(
      calls.filter((call) => call === "GET /b1s/v1/Drafts").length,
      2,
    );
  } finally {
    prepared.dispose();
  }
  assert.equal(takeCaseSapReadAhead(row, "test"), undefined);
});

test("case, owner, SAP company and connection changes cannot borrow another preparation", async (t) => {
  setup(t);
  const db = database();
  for (const mismatch of [
    "owner",
    "company",
    "connection",
    "project",
    "missing-connection",
  ] as const) {
    const handle = startCaseSapReadAhead({
      db,
      caseRow: row,
      documents: [document],
    })!;
    await handle.finished;
    handle.commit();
    assert.equal(
      takeCaseSapReadAhead({ ...row, id: "another-case" }, "test"),
      undefined,
    );
    if (mismatch === "connection") process.env.SAP_SL_TEST_PASSWORD = "rotated";
    if (mismatch === "project")
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://another.example.test";
    if (mismatch === "missing-connection")
      delete process.env.SAP_SL_TEST_PASSWORD;
    assert.equal(
      takeCaseSapReadAhead(
        mismatch === "owner" ? { ...row, owner_user_id: "another-owner" } : row,
        mismatch === "company" ? "live" : "test",
      ),
      undefined,
    );
    process.env.SAP_SL_TEST_PASSWORD = "fixture";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://database.example.test";
  }
});

test("an unavailable or discarded speculative read never prevents normal final matching", async (t) => {
  const { control } = setup(t);
  const db = database();
  control.failReads = true;
  const handle = startCaseSapReadAhead({
    db,
    caseRow: row,
    documents: [document],
  })!;
  await handle.finished;
  handle.commit();
  const prepared = takeCaseSapReadAhead(row, "test")!;
  control.failReads = false;
  try {
    const result = await withSapServiceLayer(
      (client) =>
        computeCaseMatch({ db, client, caseRow: row, reads: prepared.reads }),
      "test",
    );
    assert.equal(result.available, true);
    assert.equal(prepared.reusedReads(), 0);
  } finally {
    prepared.dispose();
  }
  const cancelled = startCaseSapReadAhead({
    db,
    caseRow: row,
    documents: [document],
  })!;
  cancelled.discard();
  await cancelled.finished;
  cancelled.commit();
  assert.equal(takeCaseSapReadAhead(row, "test"), undefined);
});

test("disabled preparation and multi-invoice packets create no speculative SAP session", async (t) => {
  const { calls } = setup(t);
  const db = database();
  process.env.SAP_MATCH_READ_AHEAD_ENABLED = "false";
  assert.equal(
    startCaseSapReadAhead({ db, caseRow: row, documents: [document] }),
    undefined,
  );
  process.env.SAP_MATCH_READ_AHEAD_ENABLED = "true";
  assert.equal(
    startCaseSapReadAhead({
      db,
      caseRow: row,
      documents: [document, { ...document, id: "second" }],
    }),
    undefined,
  );
  assert.deepEqual(calls, []);
});
