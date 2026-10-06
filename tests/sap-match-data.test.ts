import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authoritativeOutlierDocumentIds,
  computeCaseMatch,
} from "../src/server/sap/match-data";
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

const CASE = {
  id: "case-1",
  invoice_number: "1444099137",
  po_number: "TGPO26-0412",
};

function sapClient(overrides: Record<string, unknown> = {}) {
  const receipts = [
    {
      DocEntry: 8412,
      DocNum: 4412,
      DocDate: "2026-06-13",
      CardCode: "V-TATA01",
      NumAtCard: "1444099137",
      BPL_IDAssignedToInvoice: 1,
      DocumentLines: [
        {
          LineNum: 0,
          ItemCode: "BW-TW20-091",
          Quantity: 34.98,
          RemainingOpenQuantity: 34.98,
          Price: 68000,
          LineStatus: "bost_Open",
          BaseType: 22,
          BaseEntry: 77,
          BaseLine: 0,
          WarehouseCode: "HYD-01",
        },
      ],
    },
  ];
  return {
    listSuppliers: async () => [
      { CardCode: "V-TATA01", CardName: "Tata Steel Limited" },
      { CardCode: "V-OTHER", CardName: "Other Traders" },
    ],
    getSupplier: async (cardCode: string) =>
      cardCode === "V-TATA01"
        ? { CardCode: "V-TATA01", CardName: "Tata Steel Limited" }
        : null,
    searchSuppliers: async () => [
      { CardCode: "V-TATA01", CardName: "Tata Steel Limited" },
    ],
    findOpenReceiptDocumentsForInvoice: async () => receipts,
    listOpenReceiptDocumentsForVendor: async () => receipts,
    listOpenPurchaseOrdersForVendor: async () => [],
    listPurchaseOrdersByEntries: async () => [
      {
        DocEntry: 77,
        DocNum: 412,
        NumAtCard: "TGPO26-0412",
        CardCode: "V-TATA01",
        DocumentLines: [
          {
            LineNum: 0,
            ItemCode: "BW-TW20-091",
            Quantity: 100,
            RemainingOpenQuantity: 65,
            Price: 68000,
            LineStatus: "bost_Open",
          },
        ],
      },
    ],
    listItemsByCodes: async () => [
      {
        ItemCode: "BW-TW20-091",
        ItemName: "Binding Wire TW20 0.91mm",
        InventoryItem: "tYES",
      },
    ],
    findInvoiceByReference: async () => null,
    findDraftByVendorReference: async () => null,
    ...overrides,
  };
}

const tables = (): Record<string, Array<Record<string, unknown>>> => ({
  packet_documents: [
    {
      case_id: "case-1",
      client_document_id: "invoice-page",
      document_type: "Tax Invoice",
      extracted_fields: invoiceFields,
    },
    {
      case_id: "case-1",
      client_document_id: "eway-page",
      document_type: "E-Way Bill",
      extracted_fields: { vehicleNumber: "JH 02 BR 9642" },
    },
  ],
  packet_mismatches: [],
  sap_match_rules: [
    {
      organization_id: "default",
      qty_tolerance_pct: 1,
      rate_tolerance_pct: 0.5,
      freight_policy: "expense",
      posting_date: "invoice",
      receipt_window_days: 30,
      branches: [
        { stateCode: "36", name: "Hyderabad", bplId: 1, warehouse: "HYD-01" },
      ],
    },
  ],
  sap_match_state: [],
  sap_vendor_mappings: [],
  sap_item_mappings: [
    {
      vendor_card_code: "V-TATA01",
      vendor_item_key: "3434405",
      sap_item_code: "BW-TW20-091",
    },
  ],
});

test("authoritative unrelated-document evidence is the only source of SAP exclusions", () => {
  const excluded = authoritativeOutlierDocumentIds([
    {
      field_name: "unrelatedDocument",
      resolution_status: "pending",
      values_json: [
        { docId: "invoice-page", isOutlier: false },
        { docId: "wrong-lr-page", isOutlier: true },
      ],
    },
    {
      field_name: "unrelatedDocument",
      resolution_status: "rejected",
      values_json: [{ docId: "reviewer-restored-page", isOutlier: true }],
    },
    {
      field_name: "vehicleNumber",
      resolution_status: "pending",
      values_json: [{ docId: "different-kind-of-mismatch", isOutlier: true }],
    },
  ]);

  assert.deepEqual([...excluded], ["wrong-lr-page"]);
});

test("an unrelated document cannot contaminate the SAP vehicle and LR inputs", async () => {
  const data = tables();
  data.packet_documents.push({
    case_id: "case-1",
    client_document_id: "wrong-lr-page",
    document_type: "Lorry Receipt",
    extracted_fields: {
      vehicleNumber: "KA01AM5199",
      lorryReceiptNumber: "812",
    },
  });
  data.packet_mismatches = [
    {
      case_id: "case-1",
      field_name: "unrelatedDocument",
      resolution_status: "pending",
      values_json: [
        { docId: "invoice-page", isOutlier: false },
        { docId: "wrong-lr-page", isOutlier: true },
      ],
    },
  ];
  const receivedLookups: Array<Record<string, unknown>> = [];

  const match = await computeCaseMatch({
    db: fakeDb(data) as never,
    client: sapClient({
      findOpenReceiptDocumentsForInvoice: async (
        input: Record<string, unknown>,
      ) => {
        receivedLookups.push(input);
        return sapClient().findOpenReceiptDocumentsForInvoice();
      },
    }) as never,
    caseRow: CASE,
  });

  assert.ok(match.available);
  assert.deepEqual(receivedLookups[0]?.vehicles, ["JH02BR9642"]);
  assert.equal(receivedLookups[0]?.lorryReceipt, null);
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

test("matching records supplier identification, item mapping scope and the returned GRPO search", async () => {
  const data = tables();
  // Deliberately put the shared mapping last: the supplier-specific link wins.
  data.sap_item_mappings.push({
    vendor_card_code: "*",
    vendor_item_key: "3434405",
    sap_item_code: "WRONG-SHARED",
  });
  const match = await computeCaseMatch({
    db: fakeDb(data) as never,
    client: sapClient({
      searchSuppliers: async () => [
        {
          CardCode: "V-TATA01",
          CardName: "Different registered SAP name",
          BPAddresses: [{ GSTIN: "20AAACT2803M2ZO" }],
        },
      ],
      findOpenReceiptDocumentsForInvoice: async (input: {
        onSearch?: (value: Record<string, unknown>) => void;
      }) => {
        const receipts = await sapClient().findOpenReceiptDocumentsForInvoice();
        input.onSearch?.({
          field: "Invoice No.",
          value: "1444099137",
          identifiers: [{ field: "Invoice No.", value: "1444099137" }],
          documentsRead: receipts.length,
          limit: 100,
        });
        return receipts;
      },
    }) as never,
    caseRow: CASE,
  });
  assert.ok(match.available);
  assert.equal(match.result.supplierIdentification?.method, "gstin");
  assert.deepEqual(match.result.supplierIdentification?.sapGstins, [
    "20AAACT2803M2ZO",
  ]);
  assert.equal(match.result.receiptSearch?.field, "Invoice No.");
  assert.deepEqual(match.result.receiptSearch?.identifiers, [
    { field: "Invoice No.", value: "1444099137" },
  ]);
  assert.equal(match.result.receiptSearch?.supplementedByVendor, true);
  assert.equal(match.result.receiptSearch?.documentsRead, 1);
  assert.equal(match.result.lines[0].itemCode, "BW-TW20-091");
  assert.equal(match.result.lines[0].itemIdentification?.scope, "supplier");
  assert.equal(match.result.lines[0].candidates[0].purchaseOrder?.docNum, 412);
  assert.equal(
    match.result.lines[0].candidates[0].references?.invoice,
    "1444099137",
  );
  assert.ok(match.result.checkedAt);
});

test("an exact GRPO hit is supplemented with the supplier's other open GRPOs", async () => {
  const client = sapClient();
  const exact = await client.findOpenReceiptDocumentsForInvoice();
  const second = {
    ...exact[0],
    DocEntry: 8420,
    DocNum: 4420,
    NumAtCard: null,
    DocumentLines: exact[0].DocumentLines.map((line) => ({
      ...line,
      Quantity: 12,
      RemainingOpenQuantity: 12,
    })),
  };
  const match = await computeCaseMatch({
    db: fakeDb(tables()) as never,
    client: sapClient({
      findOpenReceiptDocumentsForInvoice: async () => exact,
      listOpenReceiptDocumentsForVendor: async () => [...exact, second],
    }) as never,
    caseRow: CASE,
  });

  assert.ok(match.available);
  assert.deepEqual(
    match.result.lines[0].candidates.map((candidate) => candidate.docEntry),
    [8412, 8420],
  );
  assert.equal(match.result.receiptSearch?.supplementedByVendor, true);
  assert.equal(match.result.receiptSearch?.documentsRead, 2);
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
  assert.ok(
    match.available &&
      match.result.checks.some((c) => c.id === "map-0" && c.sev === "block"),
  );
  assert.equal(
    match.available &&
      match.result.checks.find((c) => c.id === "map-0")?.itemSuggestions?.[0]
        ?.itemCode,
    "BW-TW20-091",
  );
});

test("an invoice already posted in SAP is a duplicate", async () => {
  const match = await computeCaseMatch({
    db: fakeDb(tables()) as never,
    client: sapClient({
      findInvoiceByReference: async () => ({
        DocNum: 23755,
      }),
    }) as never,
    caseRow: CASE,
  });
  assert.ok(match.available);
  if (match.available) {
    assert.equal(match.result.status, "blocked");
    assert.match(
      match.result.checks.find((c) => c.id === "dup")!.title,
      /23755/,
    );
  }
});

test("the draft this app made for the same case is not a duplicate, another draft is", async () => {
  const ours = await computeCaseMatch({
    db: fakeDb(tables()) as never,
    client: sapClient({
      findDraftByVendorReference: async () => ({
        DocNum: 5,
        Comments: "Samrat case case-1 AP invoice draft",
      }),
    }) as never,
    caseRow: CASE,
  });
  assert.ok(ours.available && ours.result.status === "ready");
  const theirs = await computeCaseMatch({
    db: fakeDb(tables()) as never,
    client: sapClient({
      findDraftByVendorReference: async () => ({
        DocNum: 9,
        Comments: "manual",
      }),
    }) as never,
    caseRow: CASE,
  });
  assert.ok(theirs.available && theirs.result.status === "blocked");
});

test("a case without a numbered invoice reports why nothing can be matched", async () => {
  const data = tables();
  data.packet_documents = [
    {
      case_id: "case-1",
      document_type: "Purchase Order",
      extracted_fields: {},
    },
  ];
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
    client: sapClient({
      searchSuppliers: async () => [],
      listSuppliers: async () => [
        {
          CardCode: "V-OTHER",
          CardName: "Other Traders",
        },
      ],
    }) as never,
    caseRow: CASE,
  });
  assert.ok(match.available);
  if (match.available) {
    assert.equal(match.result.status, "blocked");
    assert.match(
      match.result.checks.find((c) => c.id === "vendor")!.title,
      /No SAP vendor found/,
    );
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
      searchSuppliers: async () => [],
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
  data.sap_match_state = [
    {
      case_id: "case-1",
      decisions: {
        "vendor-link": {
          choice: "V-TATA01",
          reason: "Reviewer selected Tata Steel Limited",
          at: "2026-09-29T10:00:00.000Z",
        },
      },
      allocations: {},
    },
  ];
  const match = await computeCaseMatch({
    db: fakeDb(data) as never,
    client: sapClient({
      listSuppliers: async () => {
        throw new Error(
          "A confirmed vendor must not trigger a full supplier scan.",
        );
      },
      getSupplier: async () => ({
        CardCode: "V-TATA01",
        CardName: "TATA STEEL LIMITED(WIRON)",
        BPAddresses: [{ GSTIN: "20AAACT2803M2ZO" }],
      }),
    }) as never,
    caseRow: CASE,
  });
  assert.ok(match.available);
  if (match.available) {
    assert.equal(match.vendor?.cardCode, "V-TATA01");
    assert.equal(match.result.supplierIdentification?.method, "reviewer");
  }
});

test("a vendor linked earlier is used even when the names differ", async () => {
  const data = tables();
  data.sap_vendor_mappings = [
    {
      vendor_key: "G:20AAACT2803M2ZO|I:3434405",
      sap_card_code: "V-TATA01",
      sap_card_name: "Tata Steel Limited",
    },
  ];
  const match = await computeCaseMatch({
    db: fakeDb(data) as never,
    client: sapClient({
      listSuppliers: async () => {
        throw new Error(
          "An exact saved link must not trigger a full supplier scan.",
        );
      },
      getSupplier: async () => ({
        CardCode: "V-TATA01",
        CardName: "TSL Steel (Jamshedpur)",
      }),
    }) as never,
    caseRow: CASE,
  });
  assert.ok(match.available);
  if (match.available) {
    assert.equal(match.vendor?.cardCode, "V-TATA01");
    assert.equal(match.result.status, "ready");
    assert.equal(match.result.supplierIdentification?.method, "saved-mapping");
  }
});

test("a linked vendor missing from the supplier list is looked up directly", async () => {
  const data = tables();
  data.sap_vendor_mappings = [
    {
      vendor_key: "G:20AAACT2803M2ZO|I:3434405",
      sap_card_code: "V-TATA01",
      sap_card_name: "Tata",
    },
  ];
  const match = await computeCaseMatch({
    db: fakeDb(data) as never,
    client: sapClient({
      listSuppliers: async () => [],
      getSupplier: async () => ({
        CardCode: "V-TATA01",
        CardName: "Tata Steel Limited",
      }),
    }) as never,
    caseRow: CASE,
  });
  assert.ok(match.available && match.vendor?.cardCode === "V-TATA01");
});

test("no suppliers at all points to a permission problem", async () => {
  const match = await computeCaseMatch({
    db: fakeDb(tables()) as never,
    client: sapClient({
      searchSuppliers: async () => [],
      listSuppliers: async () => [],
    }) as never,
    caseRow: CASE,
  });
  assert.ok(match.available);
  if (match.available) {
    assert.match(
      match.result.checks.find((c) => c.id === "vendor")!.help ?? "",
      /no suppliers at all/,
    );
  }
});
