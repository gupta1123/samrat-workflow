import assert from "node:assert/strict";
import { test } from "node:test";
import { receiptSelection } from "../src/lib/sap-match/receipt-selection";
import { matchFixture } from "./sap-posted-fixture";

const original = matchFixture.result.lines[0];
const first = original.candidates[0];
const line = {
  ...original,
  candidates: [
    { ...first, key: "a", allocated: 2, open: 2 },
    { ...first, key: "b", allocated: 0, open: 2 },
    { ...first, key: "excluded", allocated: 0, rejected: "Wrong branch" },
  ],
};

test("split receipt edits reflect totals and never include rejected candidates", () => {
  const selection = receiptSelection(line, {
    a: "0.7",
    b: "1.3",
    excluded: "99",
  });
  assert.deepEqual(selection.allocations, { a: 0.7, b: 1.3 });
  assert.equal(selection.total, 2);
  assert.equal(selection.remaining, 0);
  assert.equal(selection.dirty, true);
  assert.deepEqual(selection.errors, {});
});

test("invalid and excessive receipt quantities have errors; partial allocation remains reviewable", () => {
  for (const raw of ["-1", "abc", "Infinity", "2.1"]) {
    assert.ok(receiptSelection(line, { a: raw }).errors.a, raw);
  }
  const partial = receiptSelection(line, { a: "1" });
  assert.equal(partial.remaining, 1);
  assert.deepEqual(partial.errors, {});
  const overBilled = receiptSelection(line, { b: "1" });
  assert.equal(overBilled.remaining, -1);
  assert.deepEqual(overBilled.errors, {});
});

test("blank deselects a receipt, equivalent numeric edits are unchanged, unknown billed stays unknown", () => {
  assert.deepEqual(receiptSelection(line, { a: "" }).allocations, {});
  assert.equal(receiptSelection(line, { a: "2.000" }).dirty, false);
  assert.equal(
    receiptSelection({ ...line, invoiceQty: null }, {}).remaining,
    null,
  );
});

test("service PO above available value is left to existing SAP review rules", () => {
  const service = {
    ...line,
    kind: "service" as const,
    invoiceAmount: 200,
    candidates: [{ ...first, key: "po", open: 100, allocated: 0 }],
  };
  const selection = receiptSelection(service, { po: "200" });
  assert.deepEqual(selection.allocations, { po: 200 });
  assert.equal(selection.remaining, 0);
  assert.deepEqual(selection.errors, {});
});
