import assert from "node:assert/strict";
import { test } from "node:test";
import { priceReviewDetails } from "../src/lib/sap-match/price-review";
import { matchFixture } from "./sap-posted-fixture";

const line = {
  ...matchFixture.result.lines[0],
  invoiceRate: 58308,
  invoiceQty: 41.8,
  allocatedQty: 41.8,
  po: {
    docNum: 100237,
    ref: "100237",
    qty: 300,
    rate: 64440,
    rateSource: "po" as const,
  },
};

test("price review uses the actual unit-rate difference and allocated quantity", () => {
  const details = priceReviewDetails(matchFixture.invoice, line, 0.5)!;
  assert.equal(details.difference, 6132);
  assert.equal(details.direction, "lower");
  assert.equal(details.percent.toFixed(2), "9.52");
  assert.equal(details.valueDifference?.toFixed(2), "256317.60");
  assert.equal(details.tolerancePct, 0.5);
  assert.equal(details.comparisonSource, "SAP PO");
  assert.equal(details.unit, "MT");
  assert.equal(details.partialAllocation, false);
});

test("partial allocations do not claim the difference covers the entire invoice", () => {
  const details = priceReviewDetails(
    matchFixture.invoice,
    { ...line, allocatedQty: 20 },
    0.5,
  )!;
  assert.equal(details.partialAllocation, true);
  assert.equal(details.valueDifference, 122640);
});

test("a higher price and GRPO fallback retain their true comparison source", () => {
  const details = priceReviewDetails(
    matchFixture.invoice,
    { ...line, invoiceRate: 65000, po: { ...line.po, rateSource: "grpo" } },
    0.5,
  )!;
  assert.equal(details.direction, "higher");
  assert.equal(details.comparisonSource, "SAP GRPO");
  const legacy = priceReviewDetails(
    matchFixture.invoice,
    { ...line, po: { ...line.po, rateSource: undefined } },
    0.5,
  )!;
  assert.equal(legacy.comparisonSource, "SAP comparison price");
});

test("missing prices or rules do not create a fabricated exception summary", () => {
  assert.equal(
    priceReviewDetails(
      matchFixture.invoice,
      { ...line, invoiceRate: null },
      0.5,
    ),
    undefined,
  );
  assert.equal(
    priceReviewDetails(matchFixture.invoice, { ...line, po: null }, 0.5),
    undefined,
  );
  assert.equal(
    priceReviewDetails(
      matchFixture.invoice,
      { ...line, po: { ...line.po, rate: 0 } },
      0.5,
    ),
    undefined,
  );
  assert.equal(
    priceReviewDetails(matchFixture.invoice, line, undefined),
    undefined,
  );
});

test("no allocation does not display zero as an invoice-value difference", () => {
  assert.equal(
    priceReviewDetails(matchFixture.invoice, { ...line, allocatedQty: 0 }, 0.5)
      ?.valueDifference,
    null,
  );
});
