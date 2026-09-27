import assert from "node:assert/strict";
import test from "node:test";

import {
  DOC_TYPE_EXTRACTION_FIELDS as clientFields,
  sanitizeFieldsForDocType as sanitizeClientFields,
} from "../src/lib/document-schema";
import {
  DOC_TYPE_EXTRACTION_FIELDS as serverFields,
  sanitizeFieldsForDocType as sanitizeServerFields,
} from "../src/server/document-schema";

const deliveryReferenceFields = [
  "referenceInvoiceNumber",
  "referencePoNumber",
  "eWayBillNumber",
  "lorryReceiptNumber",
  "supplierGstin",
  "buyerGstin",
  "unit",
] as const;

test("delivery documents accept their own printed packet references", () => {
  for (const documentType of ["Delivery Note", "Delivery Challan"] as const) {
    for (const field of deliveryReferenceFields) {
      assert.ok(
        serverFields[documentType].includes(field),
        `${documentType} server extraction must allow ${field}`,
      );
      assert.ok(
        clientFields[documentType].includes(field),
        `${documentType} client display must allow ${field}`,
      );
    }
  }
});

test("purchase-order dates and weighment LR references survive the shared schema boundary", () => {
  for (const documentType of [
    "Purchase Order",
    "Amended Purchase Order",
  ] as const) {
    assert.ok(serverFields[documentType].includes("documentDate"));
    assert.ok(clientFields[documentType].includes("documentDate"));
    assert.equal(
      sanitizeServerFields(documentType, { documentDate: "2026-09-15" })
        .documentDate,
      "2026-09-15",
    );
    assert.equal(
      sanitizeClientFields(documentType, { documentDate: "2026-09-15" })
        .documentDate,
      "2026-09-15",
    );
  }
  assert.ok(serverFields["Weighment Slip"].includes("lorryReceiptNumber"));
  assert.ok(clientFields["Weighment Slip"].includes("lorryReceiptNumber"));
});
