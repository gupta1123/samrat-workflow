import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sapMessage,
  sapMatchPresentation,
} from "../src/lib/sap-match/terminology";
import { matchFixture } from "./sap-posted-fixture";

test("SAP copy distinguishes posting, document dates, GRPOs and vendor payment", () => {
  assert.equal(sapMessage("Matched to receipt 718"), "Matched to GRPO 718");
  assert.equal(
    sapMessage("Posting it again would pay the vendor twice."),
    "Posting again would create a duplicate A/P Invoice.",
  );
  assert.equal(
    sapMessage("The booking date moves; the GST date stays."),
    "The Posting Date moves; the Document Date stays.",
  );
  assert.equal(
    sapMessage("Pay freight separately?"),
    "Exclude freight from this A/P Invoice?",
  );
  assert.equal(
    sapMessage("Pay more than the PO allows?"),
    "Post an invoice above the PO Open Amount?",
  );
  assert.equal(
    sapMessage("Billed 2 of the 5 received"),
    "Invoice Qty. 2 of GRPO Open Qty. 5",
  );
  assert.equal(
    sapMessage("same quantity"),
    "Invoice Qty. matches GRPO Open Qty.",
  );
  assert.equal(
    sapMessage("same truck (TRUCK1)"),
    "Vehicle No. matches (TRUCK1)",
  );
  assert.equal(sapMessage("same lorry receipt"), "Lorry Receipt No. matches");
  assert.equal(
    sapMessage("Lorry Receipt 123; lorry receipt 456; receipt 718"),
    "Lorry Receipt 123; lorry receipt 456; GRPO 718",
  );
});

test("saved comparisons normalize generated copy without changing decisions, business data or posting payload", () => {
  const result = structuredClone(matchFixture.result);
  const check = result.checks[0];
  check.title = "Matched to receipt 718";
  check.help =
    "receipt supplies: same truck. Customer note: pay receipt later.";
  check.decision = {
    choice: "ok",
    reason: "pay receipt later",
    at: "2026-10-04T00:00:00Z",
    effect: "resolve",
  };
  check.options = [
    {
      choice: "ok",
      title: "Yes, this receipt is right",
      lines: ["Receipt 718"],
      effect: "resolve",
    },
  ];
  result.open = [check];
  const candidate = result.lines[0].candidates[0];
  candidate.note = "pay receipt later";
  candidate.good = ["same truck", "same quantity"];
  const before = structuredClone(result);
  const display = sapMatchPresentation(result, ["receipt supplies"]);
  assert.equal(display.checks[0].title, "Matched to GRPO 718");
  assert.equal(
    display.checks[0].help,
    "receipt supplies: Vehicle No. matches. Customer note: pay receipt later.",
  );
  assert.equal(display.checks[0].options?.[0].lines[0], "GRPO 718");
  assert.equal(display.open[0], display.checks[0]);
  assert.equal(display.payload, result.payload);
  assert.deepEqual(display.payload, before.payload);
  assert.deepEqual(display.baseDocuments, before.baseDocuments);
  assert.deepEqual(display.checks[0].decision, before.checks[0].decision);
  assert.deepEqual(display.lines[0].candidates[0], {
    ...before.lines[0].candidates[0],
    good: ["Vehicle No. matches", "Invoice Qty. matches GRPO Open Qty."],
  });
  assert.equal(display.lines[0].allocatedQty, before.lines[0].allocatedQty);
  assert.equal(display.status, before.status);
  assert.deepEqual(result, before);
  assert.deepEqual(
    sapMatchPresentation(display, ["receipt supplies"]),
    display,
  );
});

test("SAP display normalization is idempotent", () => {
  for (const copy of [
    "Goods Receipt POs",
    "AP invoice draft",
    "Matched to receipt 718",
    "same lorry receipt",
    "Document Date unchanged",
    "Pay ₹100",
  ]) {
    assert.equal(sapMessage(sapMessage(copy)), sapMessage(copy));
  }
});
