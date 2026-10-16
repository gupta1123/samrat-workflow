import assert from "node:assert/strict";
import test from "node:test";
import { jobErrorMessage } from "@/server/sap/match-job";

test("database errors keep their message instead of [object Object]", () => {
  assert.equal(
    jobErrorMessage({
      message: "canceling statement due to statement timeout",
      code: "57014",
    }),
    "canceling statement due to statement timeout (57014)",
  );
  assert.equal(jobErrorMessage(new Error("boom")), "boom");
  assert.equal(jobErrorMessage({ a: 1 }), '{"a":1}');
  assert.equal(jobErrorMessage(null), "SAP matching failed.");
});
