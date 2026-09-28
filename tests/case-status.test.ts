import assert from "node:assert/strict";
import { test } from "node:test";

import { getCaseDisplayStatus } from "../src/lib/case-status";

test("reviewed case statuses have unambiguous decision labels", () => {
  assert.deepEqual(getCaseDisplayStatus("accepted"), {
    label: "Approved",
    tone: "success",
    hasFinalDecision: true,
  });
  assert.deepEqual(getCaseDisplayStatus("rejected"), {
    label: "Rejected",
    tone: "danger",
    hasFinalDecision: true,
  });
  assert.deepEqual(getCaseDisplayStatus("completed"), {
    label: "Needs Review",
    tone: "warning",
    hasFinalDecision: false,
  });
});

test("analysis completion is not treated as a final approval", () => {
  assert.equal(getCaseDisplayStatus("completed").hasFinalDecision, false);
  assert.notEqual(getCaseDisplayStatus("completed").label, "Done");
});
