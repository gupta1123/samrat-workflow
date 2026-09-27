import assert from "node:assert/strict";
import { test } from "node:test";

import { reconcileSapDraftTotal } from "../src/server/sap/draft-total";

test("accepts a SAP draft whose DocTotal equals the vendor invoice total", () => {
  assert.deepEqual(
    reconcileSapDraftTotal({
      docTotal: 118000,
      expectedInvoiceTotal: 118000,
    }),
    {
      matches: true,
      netPayable: 118000,
      withholdingTax: 0,
      invoiceTotal: 118000,
      matchedUsingWithholding: false,
    },
  );
});

test("reconciles SAP net payable to the gross invoice total using explicit 194Q withholding", () => {
  assert.deepEqual(
    reconcileSapDraftTotal({
      docTotal: 2143122,
      withholdingTaxes: [{ WTAmount: 2145 }],
      expectedInvoiceTotal: 2145267,
    }),
    {
      matches: true,
      netPayable: 2143122,
      withholdingTax: 2145,
      invoiceTotal: 2145267,
      matchedUsingWithholding: true,
    },
  );
});

test("does not add withholding when SAP DocTotal already equals the gross invoice total", () => {
  const result = reconcileSapDraftTotal({
    docTotal: 2145267,
    withholdingTaxes: [{ WTAmount: 2145 }],
    expectedInvoiceTotal: 2145267,
  });
  assert.equal(result?.matches, true);
  assert.equal(result?.invoiceTotal, 2145267);
  assert.equal(result?.matchedUsingWithholding, false);
});

test("still blocks a genuine total mismatch", () => {
  const result = reconcileSapDraftTotal({
    docTotal: 100000,
    withholdingTaxes: [{ WTAmount: 100 }],
    expectedInvoiceTotal: 118000,
  });
  assert.equal(result?.matches, false);
});

test("rejects a missing SAP draft total", () => {
  assert.equal(
    reconcileSapDraftTotal({
      docTotal: undefined,
      expectedInvoiceTotal: 118000,
    }),
    null,
  );
});
