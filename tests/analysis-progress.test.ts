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

test("analysis errors never expose raw provider or internal diagnostics", () => {
  const messages = [
    "Required extraction review failed after 2 attempts. The extraction reviewer did not return a JSON object.",
    "Independent extraction validation failed after 2 attempts.",
    "insufficient credits",
    "Request body exceeds the provider maximum size: 20331542 bytes exceeds the 20000000 byte limit for Google AI Studio",
    "OpenRouter google/gemini-pro-latest reached 32768 tokens",
    "Unrecognised provider error with private diagnostics",
    null,
    undefined,
  ];
  for (const error of messages) {
    assert.equal(
      getFriendlyAnalysisError(error),
      "We couldn't finish checking your documents. Please retry the analysis. If this happens again, contact support with your case ID.",
    );
  }
});
