import assert from "node:assert/strict";
import { test } from "node:test";
import { invoiceCurrencyMatchesSap } from "../src/server/sap/currency";
import { buildMatchInvoice } from "../src/server/sap/match-mapping";

const gstins = ["20AAACT2803M2ZO", "37AAQCS9189P1ZW"];

test("the Tata invoice's printed Rs. currency agrees with SAP INR without rewriting source fields", () => {
  const fields = {
    invoiceNumber: "9414018197",
    currency: "Rs.",
    supplierGstin: gstins[0],
    shipToGstin: gstins[1],
  };
  const invoice = buildMatchInvoice({
    caseInvoiceNumber: fields.invoiceNumber,
    casePoNumber: "100525",
    documents: [{ document_type: "Tax Invoice", extracted_fields: fields }],
  })!;
  assert.equal(
    invoiceCurrencyMatchesSap(invoice.currency, "INR", [
      invoice.vendorGstin,
      invoice.shipToGstin,
    ]),
    true,
  );
  assert.equal(fields.currency, "Rs.");
});

test("Indian rupee labels agree with INR when the invoice has Indian GST identification", () => {
  for (const currency of ["Rs.", "rs", " Rupee ", "RUPEES"])
    assert.equal(invoiceCurrencyMatchesSap(currency, "INR", gstins), true);
  assert.equal(invoiceCurrencyMatchesSap("₹", "INR"), true);
  assert.equal(invoiceCurrencyMatchesSap(" inr ", "inr"), true);
});

test("ambiguous rupee labels require Indian invoice evidence", () => {
  for (const evidence of [[], [null], ["India"], ["123"], ["GB123456789"]])
    assert.equal(invoiceCurrencyMatchesSap("Rs.", "INR", evidence), false);
});

test("genuine currency differences and ambiguous symbols remain blocked", () => {
  for (const [invoice, sap] of [
    ["USD", "INR"],
    ["INR", "USD"],
    ["PKR", "INR"],
    ["Rs.", "PKR"],
    ["Rs.", "USD"],
    ["₹", "USD"],
    ["$", "USD"],
    ["unrecognized", "INR"],
  ])
    assert.equal(invoiceCurrencyMatchesSap(invoice, sap, gstins), false);
});

test("exact currency codes still agree and missing invoice currency preserves the existing policy", () => {
  assert.equal(invoiceCurrencyMatchesSap("USD", "USD"), true);
  assert.equal(invoiceCurrencyMatchesSap("EUR", "EUR"), true);
  assert.equal(invoiceCurrencyMatchesSap(null, "INR"), true);
  assert.equal(invoiceCurrencyMatchesSap(" ", "INR"), true);
  assert.equal(invoiceCurrencyMatchesSap("INR", null), false);
  assert.equal(invoiceCurrencyMatchesSap(123, "INR"), false);
});
