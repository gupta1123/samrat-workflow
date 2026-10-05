import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMatchedDraftPayload,
  createMatchedDraft,
  MatchDraftError,
} from "../src/server/sap/match-draft";
import type { PlannedPayload } from "../src/lib/sap-match/types";

const receipt = (entry: number, open = 40) => ({
  DocEntry: entry,
  DocNum: entry - 8000,
  CardCode: "V-TATA01",
  DocCurrency: "INR",
  DocDate: "2026-06-13",
  DocumentLines: [
    { LineNum: 0, LineStatus: "bost_Open", RemainingOpenQuantity: open, TaxCode: "IGST@18",
      Price: 59000,
    },
  ],
});

function plan(overrides: Partial<PlannedPayload> = {}): PlannedPayload {
  return {
    cardCode: "V-TATA01",
    numAtCard: "1444100215",
    docDate: "2026-06-24",
    taxDate: "2026-06-24",
    branchId: 1,
    comments: "Invoice 1444100215",
    lines: [
      { invoiceLineIndex: 0, itemCode: "X", quantity: 30.1, unitPrice: null, lineTotal: null, baseType: 20, baseEntry: 8431, baseLine: 0, baseDocNum: 431, warehouse: null,
      },
      { invoiceLineIndex: 0, itemCode: "X", quantity: 22.3, unitPrice: 59000, lineTotal: null, baseType: 20, baseEntry: 8433, baseLine: 0, baseDocNum: 433, warehouse: null,
      },
    ],
    freightExpense: 125760,
    freightExcluded: 0,
    bookedTaxable: 0,
    invoiceTaxable: 0,
    difference: 0,
    ...overrides,
  };
}

const bases = () =>
  new Map<string, ReturnType<typeof receipt>>([
    ["20:8431", receipt(8431)],
    ["20:8433", receipt(8433)],
  ]);

test("a multi-receipt match becomes one draft with a base link per receipt", () => {
  const { payload, currency } = buildMatchedDraftPayload({
    caseId: "case-1",
    plan: plan(),
    bases: bases(),
    freightExpenseCode: 3,
  });
  assert.equal(currency, "INR");
  assert.equal(payload.DocType, "dDocument_Items");
  assert.equal(payload.NumAtCard, "1444100215");
  assert.equal(payload.Comments, "Samrat case case-1 AP invoice draft");
  assert.deepEqual(payload.DocumentLines, [
    { BaseType: 20, BaseEntry: 8431, BaseLine: 0, Quantity: 30.1,
      UnitPrice: 59000,
    },
    { BaseType: 20, BaseEntry: 8433, BaseLine: 0, Quantity: 22.3, UnitPrice: 59000,
    },
  ]);
  assert.deepEqual(payload.DocumentAdditionalExpenses, [
    { ExpenseCode: 3, LineTotal: 125760, TaxCode: "IGST@18" },
  ]);
});

test("the draft is refused when a receipt no longer has the quantity open", () => {
  const changed = bases();
  changed.set("20:8431", receipt(8431, 10));
  assert.throws(
    () => buildMatchedDraftPayload({ caseId: "c", plan: plan(), bases: changed, freightExpenseCode: 3,
      }),
    /no longer has 30.1 open/,
  );
});

test("an explicit scanned unit price is sent even when the plan has no override", () => {
  const { payload } = buildMatchedDraftPayload({
    caseId: "c", plan: plan({freightExpense:null,lines:[plan().lines[0]]}), bases: bases(), freightExpenseCode:null, invoiceRates:[58999.9999],
  });
  assert.deepEqual(payload.DocumentLines, [{BaseType:20,BaseEntry:8431,BaseLine:0,Quantity:30.1,UnitPrice:58999.9999}]);
});

test("a freight charge needs the configured SAP expense code", () => {
  assert.throws(
    () => buildMatchedDraftPayload({ caseId: "c", plan: plan(), bases: bases(), freightExpenseCode: null,
      }),
    /SAP_FREIGHT_EXPENSE_CODE/,
  );
  const withoutFreight = buildMatchedDraftPayload({
    caseId: "c",
    plan: plan({ freightExpense: null }),
    bases: bases(),
    freightExpenseCode: null,
  });
  assert.equal(withoutFreight.payload.DocumentAdditionalExpenses, undefined);
});

test("documents of another vendor or mixed currencies are refused", () => {
  const foreign = bases();
  foreign.set("20:8433", { ...receipt(8433), CardCode: "V-OTHER" });
  assert.throws(
    () => buildMatchedDraftPayload({ caseId: "c", plan: plan(), bases: foreign, freightExpenseCode: 3,
      }),
    /different vendor/,
  );
  const mixed = bases();
  mixed.set("20:8433", { ...receipt(8433), DocCurrency: "USD" });
  assert.throws(
    () => buildMatchedDraftPayload({ caseId: "c", plan: plan(), bases: mixed, freightExpenseCode: 3,
      }),
    /different currencies/,
  );
});

test("service lines need a service-type PO and use the billed value", () => {
  const service = plan({
    freightExpense: null,
    lines: [
      { invoiceLineIndex: 0, itemCode: "SRV", quantity: 1, unitPrice: null, lineTotal: 38500, baseType: 22, baseEntry: 71091, baseLine: 0, baseDocNum: 91, warehouse: null,
      },
    ],
  });
  const po = (docType: string) =>
    new Map([
      [
        "22:71091",
        { DocEntry: 71091, DocNum: 91, CardCode: "V-TATA01", DocCurrency: "INR", DocType: docType, DocumentLines: [{ LineNum: 0, LineStatus: "bost_Open" }],
        },
      ],
    ]);
  const { payload } = buildMatchedDraftPayload({
    caseId: "c",
    plan: service,
    bases: po("dDocument_Service"),
    freightExpenseCode: null,
  });
  assert.equal(payload.DocType, "dDocument_Service");
  assert.deepEqual(payload.DocumentLines, [{ BaseType: 22, BaseEntry: 71091, BaseLine: 0, LineTotal: 38500 },
  ]);
  assert.throws(
    () => buildMatchedDraftPayload({ caseId: "c", plan: service, bases: po("dDocument_Items"), freightExpenseCode: null,
      }),
    /by item/,
  );
});

function fakeClient(options: { missingRateOn?: string[]; seriesError?: boolean } = {},
) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    client: {
      getAdminCurrencies: async () => ({ LocalCurrency: "INR", SystemCurrency: "USD",
      }),
      getCurrencyRate: async (_currency: string, date: string) => {
        if (options.missingRateOn?.includes(date)) throw new Error("Please update the exchange rate");
        return 83;
      },
      listApInvoicePostingDates: async () => ["2026-06-20", "2026-06-05"],
      resolveGstApInvoiceSeries: async () => 77,
      createDraft: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        if (options.seriesError && payload.Series === undefined) throw new Error("10000521 define the numbering series");
        return { DocEntry: 237650, DocNum: 12 };
      },
    },
  };
}

const base = { DocDate: "2026-06-13", Series: 5, BPL_IDAssignedToInvoice: 1 };

test("the draft is created on the requested posting date when rates exist", async () => {
  const { client, calls } = fakeClient();
  const result = await createMatchedDraft(client, {
    payload: { DocDate: "2026-06-24" },
    currency: "INR",
    postingDate: "2026-06-24",
    taxDate: "2026-06-24",
    baseDocument: base,
  });
  assert.equal(result.postingDate, "2026-06-24");
  assert.equal(result.usedHistoricalPostingDate, false);
  assert.equal(calls.length, 1);
});

test("a missing exchange rate falls back to an earlier posting date, keeping the tax date", async () => {
  const { client, calls } = fakeClient({ missingRateOn: ["2026-06-24"] });
  const result = await createMatchedDraft(client, {
    payload: { DocDate: "2026-06-24", TaxDate: "2026-06-24" },
    currency: "INR",
    postingDate: "2026-06-24",
    taxDate: "2026-06-24",
    baseDocument: base,
  });
  assert.equal(result.usedHistoricalPostingDate, true);
  assert.equal(result.postingDate, "2026-06-20");
  assert.equal(calls[0].DocDate, "2026-06-20");
  assert.equal(calls[0].TaxDate, "2026-06-24");
});

test("no fallback is used when booking on a date other than the invoice date", async () => {
  const { client } = fakeClient({ missingRateOn: ["2026-09-28"] });
  await assert.rejects(
    createMatchedDraft(client, {
      payload: {},
      currency: "INR",
      postingDate: "2026-09-28",
      taxDate: "2026-06-24",
      baseDocument: base,
    }),
    MatchDraftError,
  );
});

test("a missing numbering series retries with an existing GST series", async () => {
  const { client, calls } = fakeClient({ seriesError: true });
  const result = await createMatchedDraft(client, {
    payload: {},
    currency: "INR",
    postingDate: "2026-06-24",
    taxDate: "2026-06-24",
    baseDocument: base,
  });
  assert.equal(result.series, 77);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].Series, 77);
});
