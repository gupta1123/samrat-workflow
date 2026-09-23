import assert from "node:assert/strict";
import { test } from "node:test";

import { buildApInvoiceDraft, type SapGrpo } from "../src/server/sap/ap-draft";

const grpo: SapGrpo = {
  DocEntry: 8574,
  DocNum: 10059,
  CardCode: "VENTG1077",
  CardName: "ADITI CORPORATE SERVICES",
  DocumentStatus: "bost_Open",
  Cancelled: "tNO",
  DocumentLines: [
    { LineNum: 0, ItemCode: "VIV10796", ItemDescription: "Steel Coil", RemainingOpenQuantity: 15, LineStatus: "bost_Open" },
    { LineNum: 1, ItemCode: "VIV10797", ItemDescription: "Steel Sheet", RemainingOpenQuantity: 15, LineStatus: "bost_Open" },
  ],
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    grpo,
    expectedDocEntry: 8574,
    expectedDocNum: "10059",
    expectedCardCode: "VENTG1077",
    invoiceVendor: "ADITI CORPORATE SERVICES",
    invoiceNumber: "INV-TEST-001",
    invoiceLines: [{ itemCode: "VIV10796", description: "Steel Coil", quantity: 2 }],
    caseId: "e6c78cf6-c797-4654-803d-a768880c46ba",
    ...overrides,
  };
}

test("builds a Test AP Invoice Draft based on a verified open GRPO line", () => {
  const draft = buildApInvoiceDraft(input());
  assert.equal(draft.DocObjectCode, "18");
  assert.equal(draft.CardCode, "VENTG1077");
  assert.equal(draft.NumAtCard, "INV-TEST-001");
  assert.deepEqual(draft.DocumentLines, [{ BaseType: 20, BaseEntry: 8574, BaseLine: 0, Quantity: 2 }]);
});

test("rejects wrong GRPO or vendor before a SAP write", () => {
  assert.throws(() => buildApInvoiceDraft(input({ expectedDocEntry: 8575 })), /identity/);
  assert.throws(() => buildApInvoiceDraft(input({ invoiceVendor: "OTHER SUPPLIER" })), /vendor/);
});

test("rejects unmatched and over-quantity invoice lines", () => {
  assert.throws(() => buildApInvoiceDraft(input({ invoiceLines: [{ description: "Copper Pipe", quantity: 2 }] })), /exactly match/);
  assert.throws(() => buildApInvoiceDraft(input({ invoiceLines: [{ itemCode: "VIV10796", quantity: 16 }] })), /remaining open quantity/);
  assert.throws(() => buildApInvoiceDraft(input({ invoiceLines: [] })), /No invoice line items/);
  assert.throws(() => buildApInvoiceDraft(input({
    grpo: {
      ...grpo,
      DocumentLines: [...grpo.DocumentLines!, {
        LineNum: 2,
        ItemCode: "VIV10796",
        ItemDescription: "Steel Coil",
        RemainingOpenQuantity: 5,
        LineStatus: "bost_Open",
      }],
    },
  })), /multiple GRPO lines/);
});
