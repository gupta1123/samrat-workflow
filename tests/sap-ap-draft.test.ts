import assert from "node:assert/strict";
import { test } from "node:test";

import { buildApInvoiceDraft, buildPoApInvoiceDraft, type SapGrpo } from "../src/server/sap/ap-draft";

const grpo: SapGrpo = {
  DocEntry: 8574,
  DocNum: 10059,
  CardCode: "VENTG1077",
  CardName: "ADITI CORPORATE SERVICES",
  DocCurrency: "INR",
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
    postingDate: "2026-06-15",
    invoiceDate: "2026-06-15",
    ...overrides,
  };
}

test("builds a Test AP Invoice Draft based on a verified open GRPO line", () => {
  const draft = buildApInvoiceDraft(input());
  assert.equal(draft.DocObjectCode, "18");
  assert.equal(draft.CardCode, "VENTG1077");
  assert.equal(draft.NumAtCard, "INV-TEST-001");
  assert.equal(draft.DocDate, "2026-06-15");
  assert.equal(draft.TaxDate, "2026-06-15");
  assert.equal(draft.DocCurrency, "INR");
  assert.deepEqual(draft.DocumentLines, [{ BaseType: 20, BaseEntry: 8574, BaseLine: 0, Quantity: 2 }]);
});

test("builds the same SAP Test draft directly from a verified open purchase order", () => {
  const draft = buildPoApInvoiceDraft({
    ...input(),
    po: { ...grpo, DocType: "dDocument_Service" },
  });
  assert.equal(draft.DocObjectCode, "18");
  assert.equal(draft.DocType, "dDocument_Service");
  assert.deepEqual(draft.DocumentLines, [{ BaseType: 22, BaseEntry: 8574, BaseLine: 0, Quantity: 2 }]);
});

test("selects the correct open PO line when an item code is repeated at different quantities", () => {
  const draft = buildPoApInvoiceDraft({
    ...input({ invoiceLines: [{ itemCode: "DM0008", description: "Glow Sigin Board", quantity: 192 }] }),
    po: {
      ...grpo,
      DocumentLines: [
        { LineNum: 0, ItemCode: "DM0008", ItemDescription: "Glow Sigin Board", RemainingOpenQuantity: 192, LineStatus: "bost_Open" },
        { LineNum: 1, ItemCode: "DM0008", ItemDescription: "Glow Sigin Board", RemainingOpenQuantity: 2, LineStatus: "bost_Open" },
      ],
    },
  });
  assert.deepEqual(draft.DocumentLines, [{ BaseType: 22, BaseEntry: 8574, BaseLine: 0, Quantity: 192 }]);
});

test("rejects a closed or mismatched purchase order before any SAP write", () => {
  assert.throws(() => buildPoApInvoiceDraft({ ...input(), po: { ...grpo, DocumentStatus: "bost_Close" } }), /no longer open/);
  assert.throws(() => buildPoApInvoiceDraft({ ...input(), po: { ...grpo, CardCode: "OTHER" } }), /identity/);
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
