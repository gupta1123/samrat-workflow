import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nonStockPoReferenceMatches,
  needsNonStockPoConfirmation,
} from "../src/lib/sap-match/non-stock-po-review";
import { normalizeRef } from "../src/lib/sap-match/engine";
import { matchFixture } from "./sap-posted-fixture";

test("non-stock review recognises the explicit SIPL buyer reference without general suffix guessing", () => {
  assert.equal(nonStockPoReferenceMatches(["SIPL/100405"], [100405]), true);
  assert.equal(nonStockPoReferenceMatches([" sipl / 100405 "], [100405]), true);
  assert.equal(nonStockPoReferenceMatches(["100405"], [100405]), true);
  for (const printed of [
    "REGION/100405",
    "SO/100405",
    "SIPL/100405/26",
    "SIPL/100405-1",
    "SIPL/1004050",
    "",
    "10040",
  ])
    assert.equal(
      nonStockPoReferenceMatches([printed], [100405]),
      false,
      printed,
    );
  assert.equal(nonStockPoReferenceMatches(["SIPL/100405"], [100406]), false);
  assert.notEqual(
    normalizeRef("SIPL/100405"),
    normalizeRef("100405"),
    "shared material/GRPO normalization stays unchanged",
  );
});

test("material lines cannot enter non-stock review even if alternatives are attached", () => {
  const candidate = {
    ...matchFixture.result.lines[0].candidates[0],
    kind: "PO" as const,
    docNum: 100405,
    itemCode: "EXP-PRINT",
    documentType: "dDocument_Items" as const,
    rejected: null,
  };
  const invoice = { poReferences: ["SIPL/100405"] };
  const line = {
    ...matchFixture.result.lines[0],
    kind: "material" as const,
    nonStockPoCandidates: [candidate],
  };
  assert.equal(needsNonStockPoConfirmation(invoice, line), false);
  assert.equal(
    needsNonStockPoConfirmation(invoice, {
      ...line,
      kind: "unmapped",
      itemCode: null,
    }),
    true,
  );
  assert.equal(
    needsNonStockPoConfirmation(invoice, {
      ...line,
      kind: "unmapped",
      nonStockPoCandidates: [{ ...candidate, rejected: "Different branch" }],
    }),
    false,
  );
  assert.equal(
    needsNonStockPoConfirmation(invoice, {
      ...line,
      kind: "unmapped",
      nonStockPoCandidates: [],
    }),
    false,
  );
});
