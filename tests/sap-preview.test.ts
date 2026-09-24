import assert from "node:assert/strict";
import { test } from "node:test";

import { invoiceMoneyPreview } from "../src/server/sap/preview";

test("shows actual invoice header totals when the reviewed line has only a line total", () => {
  const preview = invoiceMoneyPreview(
    [{ extracted_fields: { subtotal: "16,12,930.00", taxAmount: "2,90,327.40", totalAmount: "19,03,257.40" } }],
    [{ rate: "60,500.00", lineTotal: "16,12,930.00", quantity: "26.660" }],
  );
  assert.deepEqual(preview.lines, [{ rate: 60500, taxableAmount: 1612930, taxAmount: null }]);
  assert.deepEqual(preview.totals, { taxable: 1612930, tax: 290327.4, total: 1903257.4 });
});

test("shows unknown money as absent rather than zero", () => {
  const preview = invoiceMoneyPreview([{ extracted_fields: {} }], [{ quantity: 1 }]);
  assert.deepEqual(preview.totals, { taxable: null, tax: null, total: null });
});
