import assert from "node:assert/strict";
import { test } from "node:test";
import { getCaseInvoiceTotal } from "../src/lib/case-invoice-total";

function document(id: string, documentType: string, totalAmount?: unknown) {
  return { id, documentType, extractedFields: { totalAmount } };
}

test("a full PO before a partial shipment never replaces the invoice total", () => {
  const po = document("po", "Purchase Order", "₹10,50,13,746.00");
  const invoice = document("invoice", "Tax Invoice", "₹29,26,631.63");
  const eway = document("eway", "E-Way Bill", "₹29,26,632.00");
  for (const packet of [
    [po, eway, invoice],
    [invoice, po, eway],
  ]) {
    assert.equal(getCaseInvoiceTotal(packet), 2926631.63);
  }
});

test("seller-chain primary invoice takes precedence over the mother bill", () => {
  const mother = document("mother", "Tax Invoice", "100000");
  const buyer = {
    ...document("saved-buyer", "Invoice", 125000),
    clientDocumentId: "buyer",
  };
  assert.equal(
    getCaseInvoiceTotal([mother, buyer], new Set(["buyer"])),
    125000,
  );
  assert.equal(
    getCaseInvoiceTotal([mother, buyer], new Set(["saved-buyer"])),
    125000,
  );
});

test("missing invoice totals never fall back to PO, freight or a taxable subtotal", () => {
  const po = document("po", "Purchase Order", "105013746");
  const invoice = {
    ...document("invoice", "Invoice"),
    extractedFields: { subtotal: "2480196.29" },
  };
  assert.equal(getCaseInvoiceTotal([po]), null);
  assert.equal(getCaseInvoiceTotal([po, invoice]), null);
  assert.equal(
    getCaseInvoiceTotal([po, document("lr", "Lorry Receipt", 1000)]),
    null,
  );
  assert.equal(
    getCaseInvoiceTotal(
      [document("mother", "Invoice", 100000), invoice],
      new Set(["invoice"]),
    ),
    null,
  );
});

test("zero is a valid extracted invoice total and unreadable totals are skipped", () => {
  assert.equal(getCaseInvoiceTotal([document("invoice", "Invoice", 0)]), 0);
  assert.equal(
    getCaseInvoiceTotal([
      document("bad", "Tax Invoice", "not visible"),
      document("invoice", "Invoice", "INR 1,234.50"),
    ]),
    1234.5,
  );
});
