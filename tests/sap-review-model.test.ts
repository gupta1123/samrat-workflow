import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkLine,
  checkRule,
  reviewModel,
  sidebarSummary,
} from "../src/lib/sap-match/review-model";
import type { MatchCheck, MatchResult } from "../src/lib/sap-match/types";
import { matchFixture } from "./sap-posted-fixture";

const check = (over: Partial<MatchCheck>): MatchCheck => ({
  id: "rate-0",
  lineIndex: 0,
  sev: "confirm",
  title: "Rate is below the PO",
  open: true,
  ...over,
});

const resultWith = (
  checks: MatchCheck[],
  payload: MatchResult["payload"] = matchFixture.result.payload,
): MatchResult => ({ ...matchFixture.result, checks, payload });

test("check ids map to a rule and an invoice line", () => {
  assert.equal(checkRule("part-0-12:0"), "part");
  assert.equal(checkLine(check({ id: "rcpt-2", lineIndex: null })), 2);
  assert.equal(checkLine(check({ id: "dup", lineIndex: null })), null);
});

test("an open price decision and a missing approval are both listed", () => {
  const model = reviewModel(resultWith([check({})]), { approved: false });
  assert.equal(model.tone, "todo");
  assert.equal(model.title, "2 steps left");
  assert.deepEqual(model.waiting, ["price decision", "case approval"]);
  assert.equal(
    model.blockedReason,
    "Waiting for price decision and case approval",
  );
  assert.equal(model.ready, false);
});

test("a blocking check says the invoice can't be sent", () => {
  const model = reviewModel(
    resultWith(
      [check({ id: "rcpt-0", sev: "block", title: "No GRPO found" })],
      null,
    ),
    { approved: true },
  );
  assert.equal(model.title, "Can't send yet");
  assert.equal(model.tone, "bad");
  assert.equal(sidebarSummary(model).pill, "Can't send yet");
});

test("an existing posted invoice is presented as already recorded, not an item matching task", () => {
  const model = reviewModel(
    {
      ...resultWith(
        [check({ id: "dup", lineIndex: null, sev: "block" })],
        null,
      ),
      existingInvoice: { docNum: 123, kind: "invoice" },
    },
    { approved: false },
  );
  assert.equal(model.title, "Already recorded in SAP");
  assert.equal(model.ready, false);
  assert.deepEqual(model.waiting, ["duplicate decision"]);
});

test("a waiting check says waiting for stores", () => {
  const model = reviewModel(
    resultWith([check({ id: "rcpt-0", sev: "wait" })], null),
    { approved: true },
  );
  assert.equal(model.title, "Waiting for stores");
  assert.equal(sidebarSummary(model).pill, "Waiting");
});

test("a returned decision ends the case", () => {
  const model = reviewModel(
    resultWith([
      check({
        open: false,
        decision: {
          choice: "return",
          effect: "return",
          at: "2026-10-09T00:00:00Z",
        },
      }),
    ]),
    { approved: true },
  );
  assert.equal(model.title, "Correction needed");
  assert.equal(model.tone, "off");
  assert.equal(model.blockedReason, "Correction needed");
  assert.deepEqual(model.waiting, []);
});

test("everything answered but no draft yet asks for a re-check", () => {
  const model = reviewModel(resultWith([check({ open: false })], null), {
    approved: true,
  });
  assert.equal(model.title, "Re-check needed");
  assert.equal(model.needsRecheck, true);
  assert.deepEqual(model.waiting, ["a SAP re-check"]);
});

test("nothing open and approved is ready", () => {
  const model = reviewModel(resultWith([check({ open: false })]), {
    approved: true,
  });
  assert.equal(model.ready, true);
  assert.equal(model.blockedReason, "");
  assert.equal(sidebarSummary(model).tone, "green");
});
