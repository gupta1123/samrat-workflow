import assert from "node:assert/strict";
import { test } from "node:test";
import {
  poNotOnInvoice,
  rankCandidates,
} from "../src/lib/sap-match/candidate-ranking";
import { matchFixture } from "./sap-posted-fixture";

const base = matchFixture.result.lines[0].candidates[0];
const candidate = (
  key: string,
  vehicle: string,
  references: Partial<NonNullable<typeof base.references>>,
  bad: string[] = [],
) => ({
  ...base,
  key,
  vehicle,
  bad,
  score: 0,
  references: { ...base.references!, ...references },
});

test("GRPOs with matching references rank first and keep non-reference warnings", () => {
  const invoice = {
    ...matchFixture.invoice,
    invoiceNumber: "2413387831",
    vehicles: ["TRUCK1"],
  };
  const ranked = rankCandidates(
    invoice,
    [
      candidate("other", "TRUCK9", { invoice: "2413387834" }, [
        "different truck (TRUCK9)",
        "received before the invoice date",
      ]),
      candidate("mine", "TRUCK1", { invoice: "2413387831-2" }),
    ],
    false,
  );
  assert.equal(ranked[0].candidate.key, "mine");
  assert.equal(ranked[0].different, 0);
  assert.ok(ranked[0].same >= 2);
  assert.equal(ranked[1].otherInvoice, "2413387834");
  assert.deepEqual(ranked[1].otherWarnings, [
    "received before the invoice date",
  ]);
});

test("a PO reference no GRPO matches is treated as not printed on the invoice", () => {
  const sales = { ...matchFixture.invoice, poReferences: ["SOKADAPA027"] };
  const candidates = [candidate("a", "TRUCK1", { po: ["100506"] })];
  assert.equal(poNotOnInvoice(sales, candidates), true);
  assert.ok(
    !rankCandidates(sales, candidates, true)[0].signals.some(
      (signal) => signal.label === "PO",
    ),
  );
  assert.equal(
    poNotOnInvoice({ ...sales, poReferences: ["100506"] }, candidates),
    false,
  );
});
