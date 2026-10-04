import assert from "node:assert/strict";
import { test } from "node:test";
import {
  postedSapDetails,
  saveSapMatch,
  postingLineSnapshot,
} from "../src/lib/sap-posted-details";
import { matchFixture, postedFixture } from "./sap-posted-fixture";

test("older postings keep their known receipt and dates without invented amounts or match checks", () => {
  const details = postedSapDetails({
    ...postedFixture,
    payload: { ...postedFixture.payload, matchSnapshot: undefined },
    response: { CardCode: "TSPL001", DraftDocEntry: 237615 },
  });
  assert.deepEqual(details.bases, [{ kind: "GRPO", number: "718" }]);
  assert.equal(details.postingDate, "2026-06-20");
  assert.equal(details.match, null);
  assert.equal(details.total, null);
  assert.equal(details.netPayable, null);
  assert.deepEqual(details.lines, []);
});
test("draft snapshots keep the ready result and actual booking date without mutating the queued match", () => {
  const snapshot = saveSapMatch(matchFixture, "2026-06-19");
  assert.equal(snapshot.result.payload?.docDate, "2026-06-19");
  assert.equal(matchFixture.result.payload?.docDate, "2026-06-20");
  assert.equal(snapshot.result.lines[0].candidates[0].open, 2);
});
test("posted details retain the original match, the posted totals and selected history only", () => {
  const details = postedSapDetails(postedFixture, [
    { action: "sap_ap_invoice_posted", created_at: "2026-10-01" },
    { action: "unrelated", created_at: "2026-10-01" },
  ]);
  assert.equal(details.match?.result.status, "ready");
  assert.equal(details.total, 236);
  assert.equal(details.lines[0].quantity, 2);
  assert.equal(details.draftNumber, "237615");
  assert.equal(details.history.length, 1);
  assert.equal(details.history[0].title, "A/P Invoice posted in SAP");
});
test("snapshots for a different invoice, vendor or blocked match are excluded", () => {
  for (const mutation of [
    { invoice: { ...matchFixture.invoice, invoiceNumber: "another-invoice" } },
    { vendor: { cardCode: "another-vendor", cardName: "Other" } },
    { result: { ...matchFixture.result, status: "blocked" } },
    { result: { ...matchFixture.result, checks: [null] } },
    { version: 2 },
  ]) {
    const details = postedSapDetails({
      ...postedFixture,
      payload: {
        ...postedFixture.payload,
        matchSnapshot: { ...postedFixture.payload.matchSnapshot, ...mutation },
      },
    });
    assert.equal(details.match, null);
  }
});
test("malformed legacy data is safe and unknown amounts stay unknown", () => {
  const details = postedSapDetails({
    payload: null,
    response: {
      PostingSummary: { total: "236", netPayable: null, lines: [null] },
    },
  });
  assert.equal(details.total, null);
  assert.equal(details.netPayable, null);
  assert.equal(details.lines[0].quantity, null);
  assert.deepEqual(details.bases, []);
});

test("the persisted invoice line snapshot only keeps posting display and base-link fields", () => {
  const [line] = postingLineSnapshot([
    {
      ItemCode: "TTR027",
      Quantity: 2,
      UnitPrice: 100,
      LineTotal: 200,
      BaseEntry: 168953,
      BaseLine: 0,
      BaseType: 20,
      InternalOnly: "ignore",
    },
  ]);
  assert.equal(line.BaseLine, 0);
  assert.equal(line.Quantity, 2);
  assert.equal("InternalOnly" in line, false);
});
