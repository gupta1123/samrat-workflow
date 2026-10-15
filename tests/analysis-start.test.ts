import assert from "node:assert/strict";
import test from "node:test";

import {
  getFriendlyAnalysisStartError,
  isConfirmedAnalysisStart,
  ANALYSIS_START_ERRORS,
} from "../src/lib/analysis-start";
import { analysisStartDatabaseError } from "../src/server/processing/analysis-start-error";

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

test("start errors use structured application reasons, never provider diagnostic text", () => {
  for (const code of Object.keys(ANALYSIS_START_ERRORS)) {
    const error = analysisStartDatabaseError({
      code: "P0001",
      details: JSON.stringify({ code }),
    })!;
    assert.equal(error.extra.code, code);
    assert.equal(getFriendlyAnalysisStartError({ code }), error.message);
  }
  const quota = analysisStartDatabaseError({
    code: "PT429",
    details: '{"code":"analysis_daily_limit"}',
  })!;
  assert.equal(quota.status, 429);
  assert.equal(
    getFriendlyAnalysisStartError({ message: "PRIVATE PROVIDER DATA" }),
    ANALYSIS_START_ERRORS.analysis_start_unconfirmed,
  );
  assert.equal(
    getFriendlyAnalysisStartError({
      code: "unknown",
      message: "PRIVATE PROVIDER DATA",
    }),
    ANALYSIS_START_ERRORS.analysis_start_unconfirmed,
  );
  assert.equal(
    analysisStartDatabaseError({
      code: "P0001",
      details: "PRIVATE PROVIDER DATA",
    })?.extra.code,
    "analysis_start_rejected",
  );
  assert.equal(
    analysisStartDatabaseError({ code: "P0001", details: '{"code":"unknown"}' })
      ?.extra.code,
    "analysis_start_rejected",
  );
  assert.equal(analysisStartDatabaseError({ code: "42501" }), null);
  assert.equal(analysisStartDatabaseError(null), null);
  assert.ok(
    getFriendlyAnalysisStartError({ isAuthError: true }).includes(
      "Sign in again",
    ),
  );
});
