import assert from "node:assert/strict";
import { test } from "node:test";

import { enrichProcessedDocuments } from "../src/server/processing/pipeline";
import type { CaseDoc } from "../src/types/pipeline";

function partyDoc(
  id: string,
  type: CaseDoc["type"],
  fields: CaseDoc["fields"],
  md: string,
): CaseDoc {
  return { id, type, title: id, pages: 1, fields, md };
}

test("invoice buyer survives when the same party is also the ship-to", () => {
  const [invoice] = enrichProcessedDocuments([
    partyDoc(
      "invoice",
      "Invoice",
      { buyerName: "Samrat Irons Private Limited" },
      "Bill To\nSamrat Irons Private Limited\nShip To\nSamrat Irons Private Limited",
    ),
  ]);

  assert.equal(invoice.fields.buyerName, "Samrat Irons Private Limited");
});

test("e-way recipient remains the packet buyer", () => {
  const [eWayBill] = enrichProcessedDocuments([
    partyDoc(
      "eway",
      "E-Way Bill",
      { buyerName: "Samrat Irons Private Limited" },
      "GSTIN of Recipient\nSamrat Irons Private Limited",
    ),
  ]);

  assert.equal(eWayBill.fields.buyerName, "Samrat Irons Private Limited");
});

test("a consignee-only logistics party is not promoted to billed buyer", () => {
  const [lorryReceipt] = enrichProcessedDocuments([
    partyDoc(
      "lr",
      "Lorry Receipt",
      { buyerName: "Destination Warehouse Limited" },
      "Consignee Name\nDestination Warehouse Limited",
    ),
  ]);

  assert.equal(lorryReceipt.fields.buyerName, undefined);
});

test("generated extracted-field headings do not override visible consignee evidence", () => {
  const [lorryReceipt] = enrichProcessedDocuments([
    partyDoc(
      "lr-reviewed",
      "Lorry Receipt",
      { buyerName: "Samrat Irons Private Limited" },
      "# Lorry Receipt\n\n## Extracted Fields\n- **Buyer Name**: Samrat Irons Private Limited\n\n## Visible Text\nConsignee Name\nSamrat Irons Private Limited",
    ),
  ]);

  assert.equal(lorryReceipt.fields.buyerName, undefined);
});
