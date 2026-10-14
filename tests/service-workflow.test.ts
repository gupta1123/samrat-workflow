import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { evaluateMatch } from "../src/lib/sap-match/engine";
import { mapPoLines, buildMatchInvoice } from "../src/server/sap/match-mapping";
import { buildMatchedDraftPayload } from "../src/server/sap/match-draft";
import { buildDraftHeaderFields } from "../src/server/sap/draft-fields";
import { draftSelectionsComplete } from "../src/lib/sap-draft-fields";
import { getMissingCorePacketDocumentGroups } from "../src/server/case-summary";
import {
  serializeFieldsWithLineItems,
  stripStoredLineItems,
} from "../src/server/line-items";
import { storedSupplyNature } from "../src/lib/supply-nature";
import { serviceOpenBalance } from "../src/lib/sap-service-balance";
import type { CaseDoc } from "../src/types/pipeline";
import type {
  MatchInvoice,
  MatchContext,
  SapPoLine,
} from "../src/lib/sap-match/types";

const invoice = (overrides: Partial<MatchInvoice> = {}): MatchInvoice => ({
  supplyNature: "services",
  invoiceNumber: "CONS/2026/17",
  invoiceDate: "2026-10-10",
  vendorName: "Aster Consulting",
  vendorGstin: null,
  shipToGstin: null,
  poReferences: ["SO-700"],
  vehicles: [],
  eWayBill: null,
  lorryReceipt: null,
  taxCharged: "unknown",
  taxRatePct: null,
  currency: "INR",
  freightAmount: 0,
  taxableTotal: 1000,
  taxTotal: null,
  total: 1000,
  lines: [
    {
      index: 0,
      vendorItemCode: null,
      description: "Monthly advisory",
      hsnSac: "998311",
      quantity: null,
      unit: null,
      rate: null,
      amount: 1000,
    },
  ],
  ...overrides,
});
const po = (overrides: Partial<SapPoLine> = {}): SapPoLine => ({
  kind: "PO",
  documentType: "dDocument_Service",
  accountCode: "EXP-CONSULT",
  docEntry: 7001,
  docNum: 700,
  lineNum: 0,
  date: "2026-10-01",
  cardCode: "V-CONSULT",
  itemCode: "",
  branchId: null,
  warehouse: null,
  poRefs: ["SO-700"],
  quantity: 0,
  openQty: 0,
  price: null,
  lineTotal: 5000,
  openAmount: 3000,
  description: "Monthly advisory",
  ...overrides,
});
const context = (pos = [po()]): MatchContext => ({
  vendor: { cardCode: "V-CONSULT", cardName: "Aster Consulting" },
  ambiguousVendors: [],
  branch: null,
  itemMap: {},
  items: {},
  receipts: [],
  poLines: pos,
  existingInvoice: null,
  today: "2026-10-14",
  closedBefore: null,
});
const sourceDoc: CaseDoc = {
  id: "invoice",
  type: "Tax Invoice",
  title: "Invoice",
  pages: 1,
  md: "Monthly advisory",
  sourceFileName: "invoice.pdf",
  sourcePageNumbers: [1],
  fields: {
    invoiceNumber: "CONS/2026/17",
    documentDate: "2026-10-10",
    servicePeriod: "01–31 October 2026",
  },
  supplyNature: {
    kind: "services",
    evidence: [{ sourcePage: 1, quote: "Monthly advisory services" }],
  },
};

test("service-only source proof survives storage and removes only goods-document requirements", () => {
  const stored = serializeFieldsWithLineItems(sourceDoc);
  assert.deepEqual(storedSupplyNature(stored), sourceDoc.supplyNature);
  const mapped = buildMatchInvoice({
    caseInvoiceNumber: null,
    casePoNumber: null,
    documents: [
      {
        document_type: "Tax Invoice",
        extracted_fields: serializeFieldsWithLineItems({
          ...sourceDoc,
          lineItems: [
            { description: "Freight service", taxableAmount: "1000" },
          ],
        }),
      },
    ],
  });
  assert.equal(mapped?.supplyNature, "services");
  assert.equal(mapped?.servicePeriod, "01–31 October 2026");
  assert.equal(mapped?.lines[0].description, "Freight service");
  assert.equal(
    Object.hasOwn(stripStoredLineItems(stored), "__supplyNature"),
    false,
  );
  assert.deepEqual(getMissingCorePacketDocumentGroups([sourceDoc]), []);
  for (const kind of ["goods", "mixed", "unknown"] as const) {
    const doc = {
      ...sourceDoc,
      supplyNature: { ...sourceDoc.supplyNature!, kind },
    };
    assert.ok(
      getMissingCorePacketDocumentGroups([doc]).includes("Weight Proof"),
    );
  }
  assert.ok(getMissingCorePacketDocumentGroups([]).includes("Invoice"));
  assert.equal(
    storedSupplyNature({ __supplyNature: { kind: "services", evidence: [] } }),
    undefined,
  );
});

test("account-based service PO lines are retained without an ItemCode and use SAP open amount", () => {
  const lines = mapPoLines(
    [
      {
        DocEntry: 7001,
        DocNum: 700,
        CardCode: "V-CONSULT",
        DocCurrency: "INR",
        DocType: "dDocument_Service",
        DocumentLines: [
          {
            LineNum: 0,
            LineStatus: "bost_Open",
            AccountCode: "EXP-CONSULT",
            ItemDescription: "Monthly advisory",
            LineTotal: 5000,
            OpenAmount: 3000,
            RemainingOpenQuantity: 0,
          },
        ],
      },
    ],
    {},
    "INR",
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].accountCode, "EXP-CONSULT");
  assert.equal(lines[0].openAmount, 3000);
  assert.equal(
    serviceOpenBalance(
      { LineStatus: "bost_Open", OpenAmount: 83000, OpenAmountFC: 1000 },
      "USD",
      "INR",
    ),
    1000,
  );
  assert.equal(
    serviceOpenBalance(
      { LineStatus: "bost_Open", LineTotal: 5000 },
      "INR",
      "INR",
    ),
    null,
  );
  assert.equal(
    serviceOpenBalance(
      { LineStatus: "bost_Open", OpenAmount: 5000 },
      "USD",
      undefined,
    ),
    null,
  );
});

test("service invoice matches an exact PO without stock item, GRPO, quantity or transporter", () => {
  const result = evaluateMatch({ invoice: invoice(), context: context() });
  assert.equal(result.status, "ready");
  assert.equal(result.method, "2-way");
  assert.equal(result.lines[0].itemCode, null);
  assert.equal(result.lines[0].po?.accountCode, "EXP-CONSULT");
  assert.equal(result.payload?.lines[0].lineTotal, 1000);
  assert.equal(result.payload?.lines[0].baseType, 22);
});

test("equal amounts or a shared account cannot select an unrelated or ambiguous service PO", () => {
  const inv = invoice({ poReferences: [] });
  assert.equal(
    evaluateMatch({
      invoice: inv,
      context: context([
        po(),
        po({ docEntry: 7002, docNum: 701, poRefs: ["SO-701"] }),
      ]),
    }).status,
    "blocked",
  );
  const ambiguous = context([po(), po({ lineNum: 1 })]);
  assert.equal(
    evaluateMatch({ invoice: invoice(), context: ambiguous }).status,
    "blocked",
  );
  const candidates = evaluateMatch({ invoice: invoice(), context: ambiguous })
    .lines[0].candidates;
  const selected = evaluateMatch({
    invoice: invoice(),
    context: ambiguous,
    state: {
      decisions: {},
      allocations: { "0": { [candidates[1].key]: 1000 } },
    },
  });
  assert.equal(selected.status, "ready");
  assert.equal(selected.payload?.lines[0].baseLine, 1);
});

test("service PO balances are shared across all invoice lines and missing amounts block", () => {
  const inv = invoice({
    taxableTotal: 4000,
    total: 4000,
    lines: [0, 1].map((index) => ({
      ...invoice().lines[0],
      index,
      amount: 2000,
    })),
  });
  assert.notEqual(
    evaluateMatch({ invoice: inv, context: context() }).status,
    "ready",
  );
  assert.equal(
    evaluateMatch({
      invoice: invoice({ lines: [{ ...invoice().lines[0], amount: null }] }),
      context: context(),
    }).status,
    "blocked",
  );
});

test("service selections reject multiple, stale, zero or conflicting PO-line choices", () => {
  const ctx = context([po(), po({ lineNum: 1 })]);
  const candidates = evaluateMatch({ invoice: invoice(), context: ctx })
    .lines[0].candidates;
  for (const selections of [
    { [candidates[0].key]: 0 },
    { [candidates[0].key]: 1000, [candidates[1].key]: 1000 },
    { stale: 1000 },
  ]) {
    assert.equal(
      evaluateMatch({
        invoice: invoice(),
        context: ctx,
        state: { decisions: {}, allocations: { "0": selections } },
      }).status,
      "blocked",
    );
  }
  assert.equal(
    evaluateMatch({
      invoice: invoice({
        lines: [{ ...invoice().lines[0], poLineReference: "99" }],
      }),
      context: context(),
    }).status,
    "blocked",
  );
  const over = evaluateMatch({
    invoice: invoice({
      taxableTotal: 4000,
      total: 4000,
      lines: [{ ...invoice().lines[0], amount: 4000 }],
    }),
    context: context(),
  });
  assert.equal(over.status, "blocked");
  assert.equal(over.payload, null);
});

test("verified goods or stock item conflicts cannot bypass material checks as services", () => {
  const inv = invoice({ supplyNature: "goods" });
  assert.notEqual(
    evaluateMatch({ invoice: inv, context: context() }).method,
    "2-way",
  );
  const c = context();
  c.items = { STOCK: { name: "Steel", inventory: true } };
  const result = evaluateMatch({
    invoice: invoice({
      lines: [{ ...invoice().lines[0], vendorItemCode: "STOCK" }],
    }),
    context: c,
  });
  assert.equal(result.status, "blocked");
});

test("a service draft uses the PO's actual expense account, amount and base link", () => {
  const plan = evaluateMatch({
    invoice: invoice(),
    context: context(),
  }).payload!;
  const base = {
    DocEntry: 7001,
    DocNum: 700,
    DocType: "dDocument_Service",
    CardCode: "V-CONSULT",
    DocCurrency: "INR",
    DocumentLines: [
      {
        LineNum: 0,
        LineStatus: "bost_Open",
        AccountCode: "EXP-CONSULT",
        OpenAmount: 3000,
      },
    ],
  };
  const create = (lines = plan.lines, remaining = 3000) =>
    buildMatchedDraftPayload({
      caseId: "case",
      plan: { ...plan, lines },
      bases: new Map([
        [
          "22:7001",
          {
            ...base,
            DocumentLines: [
              { ...base.DocumentLines[0], OpenAmount: remaining },
            ],
          },
        ],
      ]),
      localCurrency: "INR",
      freightExpenseCode: null,
    });
  assert.deepEqual(create().payload.DocumentLines, [
    {
      BaseType: 22,
      BaseEntry: 7001,
      BaseLine: 0,
      LineTotal: 1000,
      AccountCode: "EXP-CONSULT",
    },
  ]);
  assert.equal(create().payload.DocType, "dDocument_Service");
  assert.throws(() => create(plan.lines, 500), /verified open value/);
  assert.throws(
    () =>
      create(
        Array.from({ length: 4 }, (_, invoiceLineIndex) => ({
          ...plan.lines[0],
          invoiceLineIndex,
        })),
      ),
    /verified open value/,
  );
});

test("non-stock item-based service POs retain the printed hours and price, not a service-account payload", () => {
  const c = context([
    po({
      documentType: "dDocument_Items",
      itemCode: "CONS-HOUR",
      accountCode: null,
      quantity: 10,
      openQty: 10,
      price: 500,
      openAmount: 5000,
    }),
  ]);
  c.items = { "CONS-HOUR": { name: "Advisory hours", inventory: false } };
  const inv = invoice({
    lines: [
      {
        ...invoice().lines[0],
        vendorItemCode: "CONS-HOUR",
        quantity: 2,
        unit: "Hours",
        rate: 500,
      },
    ],
  });
  const result = evaluateMatch({ invoice: inv, context: c });
  assert.equal(result.status, "ready");
  const draft = buildMatchedDraftPayload({
    caseId: "case",
    plan: result.payload!,
    freightExpenseCode: null,
    bases: new Map([
      [
        "22:7001",
        {
          DocEntry: 7001,
          DocNum: 700,
          CardCode: "V-CONSULT",
          DocCurrency: "INR",
          DocType: "dDocument_Items",
          DocumentLines: [
            {
              LineNum: 0,
              LineStatus: "bost_Open",
              RemainingOpenQuantity: 10,
              Price: 500,
            },
          ],
        },
      ],
    ]),
  });
  assert.equal(draft.payload.DocType, "dDocument_Items");
  assert.deepEqual(draft.payload.DocumentLines, [
    { BaseType: 22, BaseEntry: 7001, BaseLine: 0, Quantity: 2, UnitPrice: 500 },
  ]);
});

test("service headers work with alphanumeric invoice references and no logistics UDFs", () => {
  const result = buildDraftHeaderFields({
    invoice: invoice(),
    service: true,
    metadata: [],
    documents: [
      { document_type: "Tax Invoice", extracted_fields: sourceDoc.fields },
    ],
  });
  assert.equal(result.preview.service, true);
  assert.deepEqual(result.values, {});
  assert.equal(draftSelectionsComplete(result.preview, {}), true);
  assert.ok(
    !result.preview.fields.some(
      (field) => field.key === "U_TRSPRT" || field.key === "U_SAMKTW",
    ),
  );
  const metadata = [
    {
      TableName: "OPCH",
      Name: "MTRFORM",
      Mandatory: "tYES",
      Type: "db_Alpha",
      ValidValuesMD: [{ Value: "SVC", Description: "Services" }],
    },
  ];
  const required = buildDraftHeaderFields({
    invoice: invoice(),
    service: true,
    metadata,
    documents: [
      { document_type: "Tax Invoice", extracted_fields: sourceDoc.fields },
    ],
  });
  assert.equal(required.preview.materialForm.required, true);
  assert.equal(draftSelectionsComplete(required.preview, {}), false);
  assert.equal(required.preview.materialForm.selectedValue, "");
});

test("service-period migration preserves disabled fields and does not create partial allowlists", async () => {
  const pg = new PGlite();
  await pg.exec(
    "create table field_settings (organization_id text,doc_type text,field_key text,enabled boolean,unique(organization_id,doc_type,field_key)); insert into field_settings values ('org','Invoice','invoiceNumber',true),('org','Tax Invoice','servicePeriod',false);",
  );
  const sql = readFileSync(
    "supabase/migrations/20261014105935_service_invoice_field_settings.sql",
    "utf8",
  );
  await pg.exec(sql);
  await pg.exec(sql);
  assert.deepEqual(
    (
      await pg.query(
        "select doc_type,enabled from field_settings where field_key='servicePeriod' order by doc_type",
      )
    ).rows,
    [
      { doc_type: "Invoice", enabled: true },
      { doc_type: "Tax Invoice", enabled: false },
    ],
  );
  await pg.close();
});
