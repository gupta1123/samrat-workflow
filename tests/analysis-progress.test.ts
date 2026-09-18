import assert from "node:assert/strict";
import test from "node:test";
import {
  getAnalysisProgressNotice,
  getFriendlyAnalysisError,
} from "../src/lib/analysis-progress";

const now = Date.parse("2026-09-08T09:00:00.000Z");

test("explains a scheduled retry instead of showing a frozen percentage", () => {
  const notice = getAnalysisProgressNotice(
    {
      status: "queued",
      attemptCount: 1,
      maxAttempts: 2,
      progress: 88,
      nextRunAt: "2026-09-08T09:00:30.000Z",
    },
    now,
  );
  assert.match(notice!, /previous attempt did not finish/);
  assert.match(notice!, /retry 2 of 2.*30 seconds/);
});

test("distinguishes an active final review from a stalled worker", () => {
  const active = getAnalysisProgressNotice(
    {
      status: "running",
      attemptCount: 1,
      maxAttempts: 2,
      progress: 88,
      lockedAt: "2026-09-08T08:59:50.000Z",
    },
    now,
  );
  assert.match(active!, /final check/);

  const stalled = getAnalysisProgressNotice(
    {
      status: "running",
      attemptCount: 1,
      maxAttempts: 2,
      progress: 88,
      lockedAt: "2026-09-08T08:58:00.000Z",
    },
    now,
  );
  assert.match(stalled!, /Analysis is delayed/);
  assert.match(stalled!, /retry automatically/);
});

test("turns malformed-review and provider-credit failures into useful guidance", () => {
  assert.match(
    getFriendlyAnalysisError(
      "Required extraction review failed after 2 attempts. The extraction reviewer did not return a JSON object.",
    ),
    /incomplete response.*did not save uncertain results.*retry/i,
  );
  assert.match(
    getFriendlyAnalysisError(
      "Independent extraction validation failed after 2 attempts.",
    ),
    /incomplete response.*did not save uncertain results.*retry/i,
  );
  assert.match(
    getFriendlyAnalysisError("insufficient credits"),
    /Recharge or update the provider account/,
  );
});
