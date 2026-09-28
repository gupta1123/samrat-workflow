import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAnalysisIntegrityRecord,
  getAnalysisIntegrityApprovalBlockReason,
} from "../src/lib/analysis-integrity";

test("marks a fully audited and readable analysis as verified", () => {
  const integrity = buildAnalysisIntegrityRecord({
    documentIds: ["invoice", "eway"],
    documentAudits: [
      { docId: "invoice", status: "corrected" },
      { docId: "eway", status: "verified" },
    ],
    pageQuality: [{ approvalSafe: true }, { approvalSafe: true }],
  });

  assert.equal(integrity.status, "verified");
  assert.equal(
    getAnalysisIntegrityApprovalBlockReason({
      analysisIntegrity: integrity,
      extractionReview: {
        enabled: true,
        required: true,
        authoritative: true,
      },
      lastProcessingError: null,
    }),
    null,
  );
});

test("blocks approval when extraction proof is absent or incomplete", () => {
  assert.match(
    getAnalysisIntegrityApprovalBlockReason({}) ?? "",
    /not fully verified/i,
  );

  const integrity = buildAnalysisIntegrityRecord({
    documentIds: ["invoice", "eway"],
    documentAudits: [{ docId: "invoice", status: "verified" }],
    pageQuality: [{ approvalSafe: true }, { approvalSafe: false }],
  });
  assert.equal(integrity.status, "blocked");
  assert.match(
    getAnalysisIntegrityApprovalBlockReason({
      analysisIntegrity: integrity,
      extractionReview: {
        enabled: true,
        required: true,
        authoritative: true,
      },
    }) ?? "",
    /not fully verified/i,
  );
});
