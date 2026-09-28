import assert from "node:assert/strict";
import test from "node:test";

import { inferHighConfidenceDocumentTypeFromText } from "../src/server/processing/pipeline";

test("obvious packet headings bypass AI smart-split classification", () => {
  const fixtures = [
    ["PURCHASE ORDER\nPO No: SG/26/100", "Purchase Order"],
    ["TAX INVOICE\nInvoice No: INV-42", "Tax Invoice"],
    ["E-WAY BILL\nE-Way Bill No: 123456789012", "E-Way Bill"],
    ["LORRY RECEIPT\nLR No: 99", "Lorry Receipt"],
    ["WEIGHMENT SLIP\nGross Weight: 1000 kg", "Weighment Slip"],
    ["DELIVERY NOTE\nDelivery Ref: DN-7", "Delivery Note"],
  ] as const;

  for (const [text, expected] of fixtures) {
    assert.equal(inferHighConfidenceDocumentTypeFromText(text), expected);
  }
});

test("ambiguous headings continue through the AI smart-split path", () => {
  assert.equal(
    inferHighConfidenceDocumentTypeFromText(
      "TAX INVOICE\nE-Way Bill reference: 123456789012",
    ),
    "Unknown",
  );
  assert.equal(
    inferHighConfidenceDocumentTypeFromText("Commercial packet summary"),
    "Unknown",
  );
});
