import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYSIS_MODE_COPY,
  getAnalysisModeTitle,
} from "../src/lib/analysis-mode";

test("analysis choices explain when to keep a packet together", () => {
  assert.equal(getAnalysisModeTitle("standard"), "Analyze as one case");
  assert.equal(
    ANALYSIS_MODE_COPY.standard.description,
    "Documents for one purchase or shipment.",
  );
});

test("split analysis explicitly describes separate cases", () => {
  assert.equal(
    getAnalysisModeTitle("smart_split"),
    "Split into separate cases",
  );
  assert.equal(
    ANALYSIS_MODE_COPY.smart_split.description,
    "Documents for different purchases or shipments.",
  );
});

test("retry labels preserve the selected analysis behavior", () => {
  assert.equal(getAnalysisModeTitle("standard", true), "Retry as one case");
  assert.equal(
    getAnalysisModeTitle("smart_split", true),
    "Retry and split cases",
  );
});
