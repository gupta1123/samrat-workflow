import assert from "node:assert/strict";
import { test } from "node:test";

import {
  indianFinancialYear,
  selectConfiguredGstApInvoiceSeries,
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

test("selects the configured GA series for the base document period and branch", () => {
  const selected = selectConfiguredGstApInvoiceSeries({
    branchId: 2,
    periodIndicator: "FY26",
    defaultSeries: null,
    historicalSeries: null,
    series: [
      { Series: 10, Document: "18", DocumentSubType: "GA", Locked: "tNO", PeriodIndicator: "FY25", BPLID: 2 },
      { Series: 11, Document: "18", DocumentSubType: "GA", Locked: "tNO", PeriodIndicator: "FY26", BPLID: 3 },
      { Series: 12, Document: "18", DocumentSubType: "GA", Locked: "tNO", PeriodIndicator: "FY26", BPLID: 2 },
    ],
  });
  assert.equal(selected, 12);
});

test("prefers the branch series, then a configured default, without guessing", () => {
  const common = [
    { Series: 21, Document: "18", DocumentSubType: "GA", Locked: "tNO", PeriodIndicator: "FY26", BPLID: 2 },
    { Series: 22, Document: "18", DocumentSubType: "GA", Locked: "tNO", PeriodIndicator: "FY26", BPLID: 2 },
    { Series: 23, Document: "18", DocumentSubType: "GA", Locked: "tNO", PeriodIndicator: "FY26", BPLID: null },
  ];
  assert.equal(selectConfiguredGstApInvoiceSeries({
    branchId: 2,
    periodIndicator: "FY26",
    defaultSeries: 22,
    historicalSeries: null,
    series: common,
  }), 22);
  assert.equal(selectConfiguredGstApInvoiceSeries({
    branchId: 2,
    periodIndicator: "FY26",
    defaultSeries: null,
    historicalSeries: null,
    series: common,
  }), null);
});

test("rejects locked, exhausted, wrong-period, and non-GST configured series", () => {
  const selected = selectConfiguredGstApInvoiceSeries({
    branchId: 2,
    periodIndicator: "FY26",
    defaultSeries: null,
    historicalSeries: null,
    series: [
      { Series: 31, Document: "18", DocumentSubType: "GA", Locked: "tYES", PeriodIndicator: "FY26", BPLID: 2 },
      { Series: 32, Document: "18", DocumentSubType: "GA", Locked: "tNO", PeriodIndicator: "FY26", BPLID: 2, NextNumber: 101, LastNumber: 100 },
      { Series: 33, Document: "18", DocumentSubType: "GA", Locked: "tNO", PeriodIndicator: "FY25", BPLID: 2 },
      { Series: 34, Document: "18", DocumentSubType: "--", Locked: "tNO", PeriodIndicator: "FY26", BPLID: 2 },
    ],
  });
  assert.equal(selected, null);
});
