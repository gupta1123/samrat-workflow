import assert from "node:assert/strict";
import { test } from "node:test";

import {
  sapInvoiceDate,
  sapPostingDate,
  sapTestPostingDateCandidates,
} from "../src/server/sap/dates";

test("normalizes Indian vendor invoice dates without changing their calendar day", () => {
  assert.equal(sapInvoiceDate("15 Jun 2026"), "2026-06-15");
  assert.equal(sapInvoiceDate("15/06/2026"), "2026-06-15");
  assert.equal(sapInvoiceDate("2026-06-15"), "2026-06-15");
  assert.equal(sapInvoiceDate("31/02/2026"), null);
});

test("uses the Test company's India date at the UTC midnight boundary", () => {
  assert.equal(sapPostingDate(new Date("2026-09-23T20:00:00Z")), "2026-09-24");
});

test("selects recent historical Test posting dates without crossing the base document or financial year", () => {
  assert.deepEqual(
    sapTestPostingDateCandidates({
      invoiceDate: "2026-09-24",
      baseDocumentDate: "2026-04-08T00:00:00Z",
      existingInvoiceDates: [
        "2026-04-20T00:00:00Z",
        "2026-09-23T00:00:00Z",
        "2026-09-23",
        "2026-04-07",
        "2025-12-31",
        "2026-09-24",
        "not-a-date",
      ],
    }),
    ["2026-09-23", "2026-04-20"],
  );
});

test("keeps fallback posting dates inside the invoice financial year", () => {
  assert.deepEqual(
    sapTestPostingDateCandidates({
      invoiceDate: "2026-02-10",
      existingInvoiceDates: ["2026-02-09", "2025-04-01", "2025-03-31"],
    }),
    ["2026-02-09", "2025-04-01"],
  );
});
