import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSapPayload,
  extractSapDocNum,
} from "../src/server/sap/posting";

const baseRows = [
  {
    DocEntry: 55513,
    DocNum: 15,
    "PO Line Num": 1,
    "BP Code": "OTHR094",
    "BP Name": "SCHNELL INDIA MACHINERY PVT LTD",
    ItemCode: "NINV1210",
    Dscription: "SMART COIL 13+",
    Quantity: 2,
    OpenQty: 2,
    Uom: "NOS",
    Price: 1592.8,
    TaxCode: "IGST@18",
    WhsCode: "APM-CAB",
    Project: "PRJ-CAB",
  },
];

function input(kind: "GRN" | "AP", extra: Record<string, unknown> = {}) {
  return {
    kind,
    sapEnv: "test",
    caseId: "case-1",
    caseSlug: "Schnell / SCHNELL-TEST-015",
    poNumber: "SIPL/PO/TEST/15",
    invoiceNumber: "SCHNELL-TEST-015",
    baseDocNum: "15",
    baseDocChosenBy: "reviewer" as const,
    receiptEvidence: ["Delivery Note"],
    baseRows,
    packetLines: [
      {
        description: "Smart Coil 13+",
        hsnSac: "84159000",
        quantity: "2",
        unit: "NOS",
        rate: "1592.80",
        taxableAmount: "3185.60",
        taxAmount: "573.41",
      },
    ],
    documents: [{ type: "Tax Invoice", title: "Tax Invoice", fields: {} }],
    ...extra,
  };
}

test("GRN payload carries vendor identity, base PO lines, and mapped packet lines", () => {
  const payload = buildSapPayload(input("GRN"));
  assert.equal(payload.documentType, "GRPO");
  assert.equal(payload.cardCode, "OTHR094");
  assert.equal(payload.cardName, "SCHNELL INDIA MACHINERY PVT LTD");
  assert.equal(payload.baseDocNum, "15");
  assert.equal(payload.baseDocumentLines.length, 1);
  assert.equal(payload.baseDocumentLines[0].itemCode, "NINV1210");
  assert.equal(payload.baseDocumentLines[0].poLineNum, 1);
  assert.equal(payload.packetLines[0].quantity, 2);
  assert.equal(payload.totals.totalAmount, 3759.01);
  assert.ok(!("baseGrnDocNum" in payload));
});

test("AP payload links the GRN created earlier in the same run", () => {
  const payload = buildSapPayload(input("AP", { createdGrnDocNum: "1024" }));
  assert.equal(payload.documentType, "APInvoice");
  assert.equal(
    (payload as Record<string, unknown>).baseGrnDocNum,
    "1024",
  );
});

test("missing base rows still produce a usable payload", () => {
  const payload = buildSapPayload({ ...input("GRN"), baseRows: [], baseDocNum: null });
  assert.equal(payload.cardCode, null);
  assert.deepEqual(payload.baseDocumentLines, []);
  assert.equal(payload.poNumber, "SIPL/PO/TEST/15");
});

test("created document number is read from any SAP response shape", () => {
  assert.equal(extractSapDocNum({ DocNum: 1024 }), "1024");
  assert.equal(extractSapDocNum({ DocEntry: 55513 }), "55513");
  assert.equal(extractSapDocNum({ success: true, data: { DocNum: "77" } }), "77");
  assert.equal(extractSapDocNum({ result: { docEntry: 9 } }), "9");
  assert.equal(extractSapDocNum("1042"), "1042");
  assert.equal(extractSapDocNum({}), null);
  assert.equal(extractSapDocNum(null), null);
});
