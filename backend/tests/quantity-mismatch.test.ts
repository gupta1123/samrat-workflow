import assert from "node:assert/strict";
import { test } from "node:test";

import { verifyProcessedDocuments } from "../src/server/processing/pipeline";
import type { CaseDoc } from "../src/types/pipeline";

function packetDocument(
  id: string,
  type: CaseDoc["type"],
  quantity: string,
): CaseDoc {
  const firstLineQuantity = quantity === "38.000" ? "23.000" : "25.000";
  return {
    id,
    type,
    title: type,
    pages: 1,
    fields: {
      invoiceNumber: type === "Tax Invoice" ? "RSS/26-27/2087" : undefined,
      referenceInvoiceNumber:
        type === "Tax Invoice" ? undefined : "RSS/26-27/2087",
      referencePoNumber: "SIPL/PO/26-27/0914",
      itemQuantity: quantity,
      unit: "MT",
      subtotal: "2083500.00",
      taxAmount: "375030.00",
      totalAmount: "2458530.00",
      taxRate: "18",
    },
    lineItems: [
      {
        lineNumber: "1",
        description: "TMT BAR IS 1786 FE500D - 12 MM",
        hsnSac: "72142090",
        quantity: firstLineQuantity,
        unit: "MT",
      },
      {
        lineNumber: "2",
        description: "TMT BAR IS 1786 FE500D - 16 MM",
        hsnSac: "72142090",
        quantity: "15.000",
        unit: "MT",
      },
    ],
    md:
      `Invoice RSS/26-27/2087\nQuantity ${quantity} MT\n` +
      "Taxable value 2083500.00\nIGST 375030.00\nTotal 2458530.00",
  };
}

test("a quantity conflict remains a quantity mismatch when tax evidence agrees", () => {
  const result = verifyProcessedDocuments(
    [
      packetDocument("invoice", "Tax Invoice", "40.000"),
      packetDocument("eway", "E-Way Bill", "40.000"),
      packetDocument("delivery", "Delivery Note", "38.000"),
    ],
    { considerFormatting: false },
  );

  assert.ok(
    result.mismatches.some((mismatch) =>
      ["itemQuantity", "lineItems.quantityMismatch"].includes(mismatch.field),
    ),
  );
  assert.equal(
    result.mismatches.some((mismatch) =>
      ["taxRate", "taxAmount", "subtotal", "totalAmount"].includes(
        mismatch.field,
      ),
    ),
    false,
  );
});

test("a complete clean packet produces no candidate mismatches", () => {
  const result = verifyProcessedDocuments(
    [
      packetDocument("po", "Purchase Order", "40.000"),
      packetDocument("invoice", "Tax Invoice", "40.000"),
      packetDocument("eway", "E-Way Bill", "40.000"),
      packetDocument("lorry", "Lorry Receipt", "40.000"),
      packetDocument("weighment", "Weighment Slip", "40.000"),
      packetDocument("delivery", "Delivery Note", "40.000"),
    ],
    { considerFormatting: false },
  );

  assert.deepEqual(result.mismatches, []);
});
