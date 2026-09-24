import assert from "node:assert/strict";
import { test } from "node:test";

import {
  indianFinancialYear,
  selectExistingGstApInvoiceSeries,
} from "../src/server/sap/numbering-series";

test("selects the closest existing GST AP invoice series for the same branch", () => {
  const series = selectExistingGstApInvoiceSeries({
    postingDate: "2026-04-20",
    branchId: 2,
    invoices: [
      {
        DocEntry: 1,
        DocDate: "2026-04-19",
        Series: 41,
        DocumentSubType: "bod_GSTTaxInvoice",
        BPL_IDAssignedToInvoice: 2,
        Cancelled: "tNO",
      },
      {
        DocEntry: 2,
        DocDate: "2026-04-20",
        Series: 42,
        DocumentSubType: "bod_GSTTaxInvoice",
        BPL_IDAssignedToInvoice: 2,
        Cancelled: "tNO",
      },
      {
        DocEntry: 3,
        DocDate: "2026-04-20",
        Series: 99,
        DocumentSubType: "bod_GSTTaxInvoice",
        BPL_IDAssignedToInvoice: 3,
        Cancelled: "tNO",
      },
      {
        DocEntry: 4,
        DocDate: "2026-04-20",
        Series: 100,
        DocumentSubType: "bod_GSTTaxInvoice",
        BPL_IDAssignedToInvoice: 2,
        Cancelled: "tNO",
      },
    ],
  });
  assert.equal(series, 100);
});

test("does not reuse ordinary or cancelled AP invoice series", () => {
  const series = selectExistingGstApInvoiceSeries({
    postingDate: "2026-04-20",
    branchId: 2,
    invoices: [
      {
        DocEntry: 1,
        DocDate: "2026-04-20",
        Series: 41,
        DocumentSubType: "bod_None",
        BPL_IDAssignedToInvoice: 2,
        Cancelled: "tNO",
      },
      {
        DocEntry: 2,
        DocDate: "2026-04-20",
        Series: 42,
        DocumentSubType: "bod_GSTTaxInvoice",
        BPL_IDAssignedToInvoice: 2,
        Cancelled: "tYES",
      },
    ],
  });
  assert.equal(series, null);
});

test("does not guess when the base document has no branch and SAP used multiple GST series", () => {
  const series = selectExistingGstApInvoiceSeries({
    postingDate: "2026-04-20",
    branchId: null,
    invoices: [
      {
        DocEntry: 1,
        DocDate: "2026-04-20",
        Series: 41,
        DocumentSubType: "bod_GSTTaxInvoice",
        BPL_IDAssignedToInvoice: 2,
        Cancelled: "tNO",
      },
      {
        DocEntry: 2,
        DocDate: "2026-04-20",
        Series: 42,
        DocumentSubType: "bod_GSTTaxInvoice",
        BPL_IDAssignedToInvoice: 3,
        Cancelled: "tNO",
      },
    ],
  });
  assert.equal(series, null);
});

test("derives the Indian financial year used for the series search", () => {
  assert.deepEqual(indianFinancialYear("2026-04-20"), {
    start: "2026-04-01",
    end: "2027-03-31",
  });
  assert.deepEqual(indianFinancialYear("2027-03-31"), {
    start: "2026-04-01",
    end: "2027-03-31",
  });
});
