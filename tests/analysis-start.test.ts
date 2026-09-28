import assert from "node:assert/strict";
import test from "node:test";

import { isConfirmedAnalysisStart } from "../src/lib/analysis-start";

test("accepts only an atomic Processing case with an active analysis job", () => {
  assert.equal(
    isConfirmedAnalysisStart({
      case: { status: "processing" },
      job: { id: "job-1", status: "queued" },
    }),
    true,
  );
  assert.equal(
    isConfirmedAnalysisStart({
      case: { status: "processing" },
      job: { id: "job-1", status: "running" },
    }),
    true,
  );
});

test("rejects responses that would silently leave the case in Draft", () => {
  assert.equal(
    isConfirmedAnalysisStart({
      case: { status: "draft" },
      job: { id: "job-1", status: "queued" },
    }),
    false,
  );
  assert.equal(
    isConfirmedAnalysisStart({ case: { status: "processing" }, job: null }),
    false,
  );
  assert.equal(isConfirmedAnalysisStart({ case: { status: "draft" } }), false);
});
