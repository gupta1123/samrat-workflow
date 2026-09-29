import assert from "node:assert/strict";
import { test } from "node:test";
import { computeCaseMatch } from "../src/server/sap/match-data";
import { serializeFieldsWithLineItems } from "../src/server/line-items";

// A tiny stand-in for the Supabase query builder: enough for the reads that
// computeCaseMatch performs.
function fakeDb(tables: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(table: string) {
      let rows = [...(tables[table] ?? [])];
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          rows = rows.filter((row) => row[column] === value);
          return builder;
        },
        in: (column: string, values: unknown[]) => {
          rows = rows.filter((row) => values.includes(row[column]));
          return builder;
        },
        order: () => builder,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: rows, error: null }),
      };
      return builder;
    },
  };
}

const invoiceFields = serializeFieldsWithLineItems({
  fields: {
    invoiceNumber: "1444099137",
    documentDate: "10-06-2026",
    vendorName: "TATA STEEL LIMITED",
    supplierGstin: "20AAACT2803M2ZO",
    shipToGstin: "36AAQCS9189P1ZY",
    igstRate: "18",
    freightAmount: "130685.28",
    totalTaxableAmount: "2509325.28",
    poNumber: "TGPO26-0412",
    vehicleNumber: "JH02BR9642",
  } as never,
  lineItems: [
    {
      itemCode: "3434405",
      description: "Binding Wire TW20",
      quantity: "34.980",
      unit: "MT",
      rate: "68000",
      taxableAmount: "2378640",
    },
  ] as never,
});

const CASE = { id: "case-1", invoice_number: "1444099137", po_number: "TGPO26-0412" };

function sapClient(overrides: Record<string, unknown> = {}) {
  return {
    listSuppliers: async () => [
      { CardCode: "V-TATA01", CardName: "Tata Steel Limited" },
      { CardCode: "V-OTHER", CardName: "Other Traders" },
    ],
    listOpenReceiptDocumentsForVendor: async () => [
      {
        DocEntry: 8412,
        DocNum: 4412,
        DocDate: "2026-06-13",
        CardCode: "V-TATA01",
        NumAtCard: "1444099137",
        BPL_IDAssignedToInvoice: 1,
        DocumentLines: [
          { LineNum: 0, ItemCode: "BW-TW20-091", Quantity: 34.98, RemainingOpenQuantity: 34.98, Price: 68000, LineStatus: "bost_Open", BaseType: 22, BaseEntry: 77, BaseLine: 0, WarehouseCode: "HYD-01" },
        ],
      },
    ],
    listOpenPurchaseOrdersForVendor: async () => [],
    listPurchaseOrdersByEntries: async () => [
      { DocEntry: 77, DocNum: 412, NumAtCard: "TGPO26-0412", CardCode: "V-TATA01", DocumentLines: [{ LineNum: 0, ItemCode: "BW-TW20-091", Quantity: 100, RemainingOpenQuantity: 65, Price: 68000, LineStatus: "bost_Open" }] },
    ],
    listItemsByCodes: async () => [{ ItemCode: "BW-TW20-091", ItemName: "Binding Wire TW20 0.91mm", InventoryItem: "tYES" }],
    findInvoiceByReference: async () => null,
    findDraftByVendorReference: async () => null,
    ...overrides,
  };
}

const tables = (): Record<string, Array<Record<string, unknown>>> => ({
  packet_documents: [
    { case_id: "case-1", document_type: "Tax Invoice", extracted_fields: invoiceFields },
    { case_id: "case-1", document_type: "E-Way Bill", extracted_fields: { vehicleNumber: "JH 02 BR 9642" } },
  ],
  sap_match_rules: [{ organization_id: "default", qty_tolerance_pct: 1, rate_tolerance_pct: 0.5, freight_policy: "expense", posting_date: "invoice", receipt_window_days: 30, branches: [{ stateCode: "36", name: "Hyderabad", bplId: 1, warehouse: "HYD-01" }] }],
  sap_match_state: [],
  sap_vendor_mappings: [],
  sap_item_mappings: [{ vendor_card_code: "V-TATA01", vendor_item_key: "3434405", sap_item_code: "BW-TW20-091" }],
});

test("the saved packet and SAP data flow through to a ready match", async () => {
  const match = await computeCaseMatch({
    db: fakeDb(tables()) as never,
    client: sapClient() as never,
    caseRow: CASE,
  });
  assert.equal(match.available, true);
  if (!match.available) return;
  assert.equal(match.vendor?.cardCode, "V-TATA01");
  assert.equal(match.branch?.name, "Hyderabad");
  assert.equal(match.result.status, "ready");
  assert.equal(match.result.payload?.lines[0].baseEntry, 8412);
  assert.equal(match.result.payload?.freightExpense, 130685.28);
});

test("an unlinked item blocks until it is linked", async () => {
  const data = tables();
  data.sap_item_mappings = [];
  const match = await computeCaseMatch({
    db: fakeDb(data) as never,
    client: sapClient() as never,
    caseRow: CASE,
  });
  assert.equal(match.available && match.result.status, "blocked");
  assert.ok(match.available && match.result.checks.some((c) => c.id === "map-0" && c.sev === "block"));
});

test("an invoice already posted in SAP is a duplicate", async () => {
  const match = await computeCaseMatch({
    db: fakeDb(tables()) as never,
    client: sapClient({ findInvoiceByReference: async () => ({ DocNum: 23755 }) }) as never,
    caseRow: CASE,
  });
  assert.ok(match.available);
  if (match.available) {
    assert.equal(match.result.status, "blocked");
    assert.match(match.result.checks.find((c) => c.id === "dup")!.title, /23755/);
  }
});

test("the draft this app made for the same case is not a duplicate, another draft is", async () => {
  const ours = await computeCaseMatch({
    db: fakeDb(tables()) as never,
    client: sapClient({ findDraftByVendorReference: async () => ({ DocNum: 5, Comments: "Samrat case case-1 AP invoice draft" }) }) as never,
    caseRow: CASE,
  });
  assert.ok(ours.available && ours.result.status === "ready");
  const theirs = await computeCaseMatch({
    db: fakeDb(tables()) as never,
    client: sapClient({ findDraftByVendorReference: async () => ({ DocNum: 9, Comments: "manual" }) }) as never,
    caseRow: CASE,
  });
  assert.ok(theirs.available && theirs.result.status === "blocked");
});

test("a case without a numbered invoice reports why nothing can be matched", async () => {
  const data = tables();
  data.packet_documents = [{ case_id: "case-1", document_type: "Purchase Order", extracted_fields: {} }];
  const match = await computeCaseMatch({
    db: fakeDb(data) as never,
    client: sapClient() as never,
    caseRow: CASE,
  });
  assert.equal(match.available, false);
});

test("an unknown vendor blocks with a clear reason instead of guessing", async () => {
  const match = await computeCaseMatch({
    db: fakeDb(tables()) as never,
    client: sapClient({ listSuppliers: async () => [{ CardCode: "V-OTHER", CardName: "Other Traders" }] }) as never,
    caseRow: CASE,
  });
  assert.ok(match.available);
  if (match.available) {
    assert.equal(match.result.status, "blocked");
    assert.match(match.result.checks.find((c) => c.id === "vendor")!.title, /No SAP vendor found/);
  }
});

test("multiple exact SAP GSTIN matches require an explicit vendor choice", async () => {
  const match = await computeCaseMatch({
    db: fakeDb(tables()) as never,
    client: sapClient({
      listSuppliers: async () => [
        {
          CardCode: "V-TSL-RETAIL",
          CardName: "TATA STEEL LIMITED(RETAIL)",
          BPAddresses: [{ GSTIN: "20AAACT2803M2ZO" }],
        },
        {
          CardCode: "V-TSL-WIRON",
          CardName: "TATA STEEL LIMITED(WIRON)",
          BPAddresses: [{ GSTIN: "20AAACT2803M2ZO" }],
        },
      ],
    }) as never,
    caseRow: CASE,
  });
  assert.ok(match.available);
  if (match.available) {
    const check = match.result.checks.find((c) => c.id === "vendor")!;
    assert.deepEqual(
      check.vendorSuggestions?.map((vendor) => vendor.cardCode),
      ["V-TSL-RETAIL", "V-TSL-WIRON"],
    );
    assert.match(check.help ?? "", /exact GSTIN/);
    assert.equal(check.vendorKey, "G:20AAACT2803M2ZO|I:3434405");
  }
});

test("an explicit vendor choice applies to this case when GSTIN is shared", async () => {
  const data = tables();
  data.sap_match_state = [{
    case_id: "case-1",
    decisions: {
      "vendor-link": {
        choice: "V-TATA01",
        reason: "Reviewer selected Tata Steel Limited",
        at: "2026-09-29T10:00:00.000Z",
      },
    },
    allocations: {},
  }];
  const match = await computeCaseMatch({
    db: fakeDb(data) as never,
    client: sapClient({
      listSuppliers: async () => [
        {
          CardCode: "V-TATA01",
          CardName: "TATA STEEL LIMITED(WIRON)",
          BPAddresses: [{ GSTIN: "20AAACT2803M2ZO" }],
        },
        {
          CardCode: "V-TATA02",
          CardName: "TATA STEEL LIMITED(RETAIL)",
          BPAddresses: [{ GSTIN: "20AAACT2803M2ZO" }],
        },
      ],
    }) as never,
    caseRow: CASE,
  });
  assert.ok(match.available);
  if (match.available) assert.equal(match.vendor?.cardCode, "V-TATA01");
});

test("a vendor linked earlier is used even when the names differ", async () => {
  const data = tables();
  data.sap_vendor_mappings = [{ vendor_key: "G:20AAACT2803M2ZO|I:3434405", sap_card_code: "V-TATA01", sap_card_name: "Tata Steel Limited" }];
  const match = await computeCaseMatch({
    db: fakeDb(data) as never,
    client: sapClient({
      listSuppliers: async () => [{ CardCode: "V-TATA01", CardName: "TSL Steel (Jamshedpur)" }],
    }) as never,
    caseRow: CASE,
  });
  assert.ok(match.available);
  if (match.available) {
    assert.equal(match.vendor?.cardCode, "V-TATA01");
    assert.equal(match.result.status, "ready");
  }
});

test("a linked vendor missing from the supplier list is looked up directly", async () => {
  const data = tables();
  data.sap_vendor_mappings = [{ vendor_key: "G:20AAACT2803M2ZO|I:3434405", sap_card_code: "V-TATA01", sap_card_name: "Tata" }];
  const match = await computeCaseMatch({
    db: fakeDb(data) as never,
    client: sapClient({
      listSuppliers: async () => [],
      getSupplier: async () => ({ CardCode: "V-TATA01", CardName: "Tata Steel Limited" }),
    }) as never,
    caseRow: CASE,
  });
  assert.ok(match.available && match.vendor?.cardCode === "V-TATA01");
});

test("no suppliers at all points to a permission problem", async () => {
  const match = await computeCaseMatch({
    db: fakeDb(tables()) as never,
    client: sapClient({ listSuppliers: async () => [] }) as never,
    caseRow: CASE,
  });
  assert.ok(match.available);
  if (match.available) {
    assert.match(match.result.checks.find((c) => c.id === "vendor")!.help ?? "", /no suppliers at all/);
  }
});
