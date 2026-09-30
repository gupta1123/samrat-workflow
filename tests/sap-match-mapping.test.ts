import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeFieldsWithLineItems } from "../src/server/line-items";
import {
  branchForShipTo,
  buildMatchInvoice,
  findVehicles,
  mapPoLines,
  mapReceiptLines,
  parseRulesInput,
  resolveVendor,
  rulesFromRow,
  vendorKeys,
} from "../src/server/sap/match-mapping";
import { DEFAULT_MATCH_RULES } from "../src/lib/sap-match/types";

function stored(type: string, fields: Record<string, string>, lineItems: Array<Record<string, string>> = []) {
  return {
    document_type: type,
    extracted_fields: serializeFieldsWithLineItems({
      fields: fields as never,
      lineItems: lineItems as never,
    }),
  };
}

test("vehicle numbers are found in free text and normalised", () => {
  assert.deepEqual(findVehicles("Truck JH 02 BR 9642 unloaded"), ["JH02BR9642"]);
  assert.deepEqual(findVehicles("AP-39-TB-7781, TS07UH4410"), ["AP39TB7781", "TS07UH4410"]);
  assert.deepEqual(findVehicles("no truck here"), []);
});

test("the engine invoice is built from the saved packet", () => {
  const invoice = buildMatchInvoice({
    caseInvoiceNumber: "1444099137",
    casePoNumber: "TGPO26-0412",
    documents: [
      stored(
        "Tax Invoice",
        {
          invoiceNumber: "1444099137",
          documentDate: "10-06-2026",
          vendorName: "TATA STEEL LIMITED",
          supplierGstin: "20AAACT2803M2ZO",
          shipToGstin: "36AAQCS9189P1ZY",
          igstRate: "18",
          freightAmount: "1,30,685.28",
          totalTaxableAmount: "25,09,325.28",
          poNumber: "TGPO26-0412",
          vehicleNumber: "JH02BR9642",
        },
        [
          {
            itemCode: "3434405",
            description: "Binding Wire TW20",
            quantity: "34.980",
            unit: "MT",
            rate: "68,000.00",
            taxableAmount: "23,78,640.00",
            igstAmount: "4,28,155.20",
          },
        ],
      ),
      stored("E-Way Bill", { eWayBillNumber: "481735818614", vehicleNumber: "JH 02 BR 9642" }),
      stored("Lorry Receipt", { lorryReceiptNumber: "P42321805910" }),
    ],
  });
  assert.ok(invoice);
  assert.equal(invoice.invoiceDate, "2026-06-10");
  assert.equal(invoice.taxCharged, "igst");
  assert.equal(invoice.freightAmount, 130685.28);
  assert.deepEqual(invoice.vehicles, ["JH02BR9642"]);
  assert.equal(invoice.eWayBill, "481735818614");
  assert.equal(invoice.lorryReceipt, "P42321805910");
  assert.equal(invoice.lines.length, 1);
  assert.equal(invoice.lines[0].quantity, 34.98);
  assert.equal(invoice.lines[0].rate, 68000);
  assert.deepEqual(invoice.poReferences, ["TGPO26-0412"]);
});

test("a freight line on the invoice becomes freight, not a stock line", () => {
  const invoice = buildMatchInvoice({
    caseInvoiceNumber: "INV-1",
    casePoNumber: null,
    documents: [
      stored(
        "Invoice",
        { invoiceNumber: "INV-1", cgstRate: "9", sgstRate: "9" },
        [
          { itemCode: "1428337", description: "TMT 10 mm", quantity: "10", rate: "58000", taxableAmount: "580000" },
          { description: "Freight charges", taxableAmount: "12,000.00" },
        ],
      ),
    ],
  });
  assert.ok(invoice);
  assert.equal(invoice.lines.length, 1);
  assert.equal(invoice.freightAmount, 12000);
  assert.equal(invoice.taxCharged, "split");
});

test("no numbered vendor invoice means nothing to match", () => {
  assert.equal(
    buildMatchInvoice({
      caseInvoiceNumber: null,
      casePoNumber: null,
      documents: [stored("Purchase Order", { poNumber: "P1" })],
    }),
    null,
  );
  assert.equal(
    buildMatchInvoice({
      caseInvoiceNumber: null,
      casePoNumber: null,
      documents: [stored("Invoice", { invoiceNumber: "" })],
    }),
    null,
  );
});

test("vendor resolution prefers an exact name and refuses ambiguity", () => {
  const suppliers = [
    { CardCode: "V-TATA01", CardName: "Tata Steel Limited" },
    { CardCode: "V-TATA02", CardName: "Tata Steel Long Products Limited" },
    { CardCode: "V-SSLT01", CardName: "Sri Srinivasa Lorry Transport" },
  ];
  assert.equal(
    resolveVendor({ vendorName: "TATA STEEL LIMITED", vendorGstin: null }, suppliers).vendor?.cardCode,
    "V-TATA01",
  );
  assert.equal(
    resolveVendor({ vendorName: "Unknown Traders", vendorGstin: null }, suppliers).vendor,
    null,
  );
  const duplicated = resolveVendor({ vendorName: "Sri Srinivasa Lorry Transport", vendorGstin: null }, [
    ...suppliers,
    { CardCode: "V-SSLT09", CardName: "SRI SRINIVASA LORRY TRANSPORT" },
  ]);
  assert.equal(duplicated.vendor, null);
  assert.equal(duplicated.ambiguous.length, 2);
});

test("vendor resolution uses SAP GSTIN data and never guesses between exact records", () => {
  const resolved = resolveVendor(
    { vendorName: "Name printed differently", vendorGstin: "20AAACT2803M2ZO" },
    [
      {
        CardCode: "TSPL001",
        CardName: "TATA STEEL LIMITED(RETAIL)",
        BPAddresses: [{ GSTIN: "20AAACT2803M2ZO" }],
      },
      {
        CardCode: "OTHER",
        CardName: "OTHER SUPPLIER",
        BPAddresses: [{ GSTIN: "29AAAAA0000A1Z5" }],
      },
    ],
  );
  assert.equal(resolved.vendor?.cardCode, "TSPL001");

  const ambiguous = resolveVendor(
    { vendorName: "TATA STEEL LIMITED", vendorGstin: "20AAACT2803M2ZO" },
    [
      {
        CardCode: "TSPL001",
        CardName: "TATA STEEL LIMITED(RETAIL)",
        BPAddresses: [{ GSTIN: "20AAACT2803M2ZO" }],
      },
      {
        CardCode: "TSPL003",
        CardName: "TATA STEEL LIMITED(WIRON)",
        BPAddresses: [{ GSTIN: "20AAACT2803M2ZO" }],
      },
    ],
  );
  assert.equal(ambiguous.vendor, null);
  assert.deepEqual(
    ambiguous.ambiguous.map((vendor) => vendor.cardCode),
    ["TSPL001", "TSPL003"],
  );
  assert.ok(ambiguous.ambiguous.every((vendor) => vendor.why === "Exact GSTIN match"));
});

test("goods receipts become engine lines with their PO references and vehicle", () => {
  const lines = mapReceiptLines(
    [
      {
        DocEntry: 501,
        DocNum: 4412,
        DocDate: "2026-06-13",
        CardCode: "V-TATA01",
        NumAtCard: "1444099137",
        Comments: "Truck JH02BR9642",
        BPL_IDAssignedToInvoice: 1,
        DocumentLines: [
          { LineNum: 0, ItemCode: "BW-TW20-091", Quantity: 34.98, RemainingOpenQuantity: 34.98, Price: 68000, LineStatus: "bost_Open", BaseType: 22, BaseEntry: 77, BaseLine: 3, WarehouseCode: "HYD-01" },
          { LineNum: 1, ItemCode: "BW-TW20-091", Quantity: 10, RemainingOpenQuantity: 0, LineStatus: "bost_Close" },
        ],
      },
    ],
    [{ DocEntry: 77, DocNum: 412, NumAtCard: "TGPO26-0412" }],
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].vehicle, "JH02BR9642");
  assert.equal(lines[0].vendorRef, "1444099137");
  assert.equal(lines[0].eWayBill, null);
  assert.deepEqual(lines[0].poRefs, ["412", "TGPO26-0412"]);
  assert.equal(lines[0].poLineNum, 3);
  assert.equal(lines[0].branchId, 1);
});

test("a configured user-defined field supplies the truck and PO reference", () => {
  const [line] = mapReceiptLines(
    [
      {
        DocEntry: 1,
        DocNum: 2,
        CardCode: "V",
        U_Truck: "AP 02 TH 2989",
        U_Invoice: "INV-9",
        U_EWay: "481735818614",
        U_LR: "LR-1",
        DocumentLines: [{ LineNum: 0, ItemCode: "X", Quantity: 5, RemainingOpenQuantity: 5, LineStatus: "bost_Open", BaseType: 22, BaseEntry: 9, BaseLine: 0 }],
      },
    ],
    [{ DocEntry: 9, DocNum: 90, U_PORef: "APPO26-0229" }],
    {
      vehicleField: "U_Truck",
      invoiceRefField: "U_Invoice",
      eWayBillField: "U_EWay",
      lorryReceiptField: "U_LR",
      poRefFields: ["U_PORef"],
    },
  );
  assert.equal(line.vehicle, "AP02TH2989");
  assert.equal(line.vendorRef, "INV-9");
  assert.equal(line.eWayBill, "481735818614");
  assert.equal(line.lorryReceipt, "LR-1");
  assert.ok(line.poRefs.includes("APPO26-0229"));
});

test("service PO lines expose the value still open", () => {
  const [line] = mapPoLines([
    {
      DocEntry: 71091,
      DocNum: 91,
      DocDate: "2026-04-01",
      CardCode: "V-SSLT01",
      NumAtCard: "KDP-SPO-0091",
      DocumentLines: [
        { LineNum: 0, ItemCode: "SRV-FRT", Quantity: 1, RemainingOpenQuantity: 0.6075, LineTotal: 200000, LineStatus: "bost_Open" },
      ],
    },
  ]);
  assert.equal(line.openAmount, 121500);
  assert.deepEqual(line.poRefs, ["91", "KDP-SPO-0091"]);
});

test("rules validate strictly and map branches by ship-to state", () => {
  assert.deepEqual(rulesFromRow(null), DEFAULT_MATCH_RULES);
  const rules = parseRulesInput({
    qtyTolerancePct: "0.5",
    rateTolerancePct: 1,
    freightPolicy: "item",
    postingDate: "today",
    receiptWindowDays: 20,
    branches: [{ stateCode: "37", name: "Kadapa", bplId: 2, warehouse: "KDP-01" }],
  });
  assert.equal(rules.qtyTolerancePct, 0.5);
  assert.equal(branchForShipTo("37AAQCS9189P1ZW", rules)?.name, "Kadapa");
  assert.equal(branchForShipTo("36AAQCS9189P1ZY", rules), null);
  assert.throws(() => parseRulesInput({ ...rules, qtyTolerancePct: -1 }), /Quantity limit/);
  assert.throws(() => parseRulesInput({ ...rules, freightPolicy: "free" }), /freight/);
  assert.throws(
    () => parseRulesInput({ ...rules, branches: [{ stateCode: "9", name: "x" }] }),
    /two-digit/,
  );
  assert.throws(
    () =>
      parseRulesInput({
        ...rules,
        branches: [
          { stateCode: "37", name: "A" },
          { stateCode: "37", name: "B" },
        ],
      }),
    /only one branch/,
  );
});

test("a vendor is remembered by its strongest exact identity", () => {
  assert.deepEqual(vendorKeys({
    vendorGstin: "20AAACT2803M2ZO",
    vendorName: "Tata Steel Limited",
    lines: [{ vendorItemCode: "3434405" }, { vendorItemCode: "3434405" }],
  }), [
    "G:20AAACT2803M2ZO|I:3434405",
  ]);
  assert.deepEqual(
    vendorKeys({ vendorGstin: "20AAACT2803M2ZO", vendorName: "Tata Steel Limited" }),
    [],
  );
  assert.deepEqual(vendorKeys({ vendorGstin: null, vendorName: "Tata Steel Limited" }), [
    "N:TATA STEEL LIMITED",
  ]);
  assert.deepEqual(vendorKeys({ vendorGstin: "bad", vendorName: null }), []);
});
