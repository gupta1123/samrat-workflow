import assert from "node:assert/strict";
import { test } from "node:test";

import { sapInvoiceDate, sapPostingDate } from "../src/server/sap/dates";

test("normalizes Indian vendor invoice dates without changing their calendar day", () => {
  assert.equal(sapInvoiceDate("15 Jun 2026"), "2026-06-15");
  assert.equal(sapInvoiceDate("15/06/2026"), "2026-06-15");
  assert.equal(sapInvoiceDate("2026-06-15"), "2026-06-15");
  assert.equal(sapInvoiceDate("31/02/2026"), null);
});

test("uses the Test company's India date at the UTC midnight boundary", () => {
  assert.equal(sapPostingDate(new Date("2026-09-23T20:00:00Z")), "2026-09-24");
});
