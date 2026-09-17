import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getPersistedCaseIssueCount,
  getPersistedCaseIssues,
} from "../src/lib/case-issues";

test("every persisted case issue contributes to the same count", () => {
  const issues = [
    { id: "commercial", fieldName: "quantity", resolutionStatus: "pending" },
    {
      id: "readability",
      fieldName: "documentReadability",
      resolutionStatus: "pending",
    },
    {
      id: "terms",
      fieldName: "termsAndConditions",
      resolutionStatus: "accepted",
    },
    {
      id: "future-field",
      fieldName: "newReviewerFinding",
      resolutionStatus: "rejected",
    },
  ];

  assert.strictEqual(getPersistedCaseIssues(issues), issues);
  assert.equal(getPersistedCaseIssueCount(issues), 4);
});

test("an unloaded case has zero persisted issues", () => {
  assert.deepEqual(getPersistedCaseIssues(undefined), []);
  assert.equal(getPersistedCaseIssueCount(undefined), 0);
});
