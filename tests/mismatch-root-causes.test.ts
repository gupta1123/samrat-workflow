import assert from "node:assert/strict";
import test from "node:test";
import { UNRELATED_DOCUMENT_FIELD } from "../src/lib/unrelated-document";
import {
  buildRootCauseCandidates,
  materializeRootCauseMismatches,
  validateRootCauseReview,
} from "../src/server/processing/mismatch-root-causes";
import type { Mismatch } from "../src/types/pipeline";

function mismatch(id: string, field: string): Mismatch {
  return {
    id,
    field,
    values: [
      { docId: "packet-document", value: `${field}-packet`, isOutlier: false },
      { docId: "foreign-document", value: `${field}-foreign`, isOutlier: true },
    ],
  };
}

test("one unrelated document becomes one root issue with typed supporting evidence", () => {
  const candidates = buildRootCauseCandidates([
    mismatch("lr", "lorryReceiptNumber"),
    mismatch("vehicle", "vehicleNumber"),
    mismatch("consignee", "shipToName"),
    mismatch("date", "documentDate"),
    mismatch("party", "vendorName"),
  ]);
  const review = validateRootCauseReview(
    {
      rootIssues: [
        {
          issueId: "root-1",
          kind: "unrelated_document",
          primaryMismatchId: "confirmed-1",
          memberMismatchIds: [
            "confirmed-1",
            "confirmed-2",
            "confirmed-3",
            "confirmed-4",
          ],
          outlierDocumentIds: ["foreign-document"],
          title: "Unrelated transport document",
          reason: "One document describes a different shipment.",
        },
      ],
      dismissedMismatchIds: [
        {
          mismatchId: "confirmed-5",
          reason: "The pages identify different legitimate business roles.",
        },
      ],
    },
    candidates,
  );
  const result = materializeRootCauseMismatches(review, candidates);
  assert.equal(result.length, 1);
  assert.equal(result[0].field, UNRELATED_DOCUMENT_FIELD);
  assert.deepEqual(
    [...new Set(result[0].values.map((entry) => entry.evidenceField))],
    ["lorryReceiptNumber", "vehicleNumber", "shipToName", "documentDate"],
  );
  assert.ok(
    result[0].values
      .filter((entry) => entry.docId === "foreign-document")
      .every((entry) => entry.isOutlier),
  );
});

test("root review must account for every candidate exactly once", () => {
  const candidates = buildRootCauseCandidates([mismatch("a", "vehicleNumber")]);
  assert.throws(
    () =>
      validateRootCauseReview(
        { rootIssues: [], dismissedMismatchIds: [] },
        candidates,
      ),
    /did not account/,
  );
});

test("unrelated-document grouping requires outlier and corroborating evidence", () => {
  const candidates = buildRootCauseCandidates([
    {
      id: "one-sided",
      field: "vehicleNumber",
      values: [{ docId: "foreign-document", value: "X", isOutlier: true }],
    },
  ]);
  assert.throws(
    () =>
      validateRootCauseReview(
        {
          rootIssues: [
            {
              issueId: "root-1",
              kind: "unrelated_document",
              primaryMismatchId: "confirmed-1",
              memberMismatchIds: ["confirmed-1"],
              outlierDocumentIds: ["foreign-document"],
              title: "Unrelated document",
              reason: "Different transaction.",
            },
          ],
          dismissedMismatchIds: [],
        },
        candidates,
      ),
    /lacks both outlier and corroborating evidence/,
  );
});

test("independent field discrepancies remain independent", () => {
  const candidates = buildRootCauseCandidates([
    mismatch("rate", "itemRate"),
    mismatch("quantity", "itemQuantity"),
  ]);
  const review = validateRootCauseReview(
    {
      rootIssues: candidates.map((candidate, index) => ({
        issueId: `root-${index + 1}`,
        kind: "field_discrepancy",
        primaryMismatchId: candidate.reviewId,
        memberMismatchIds: [candidate.reviewId],
        outlierDocumentIds: [],
        title: "Independent discrepancy",
        reason: "The printed commercial values differ.",
      })),
      dismissedMismatchIds: [],
    },
    candidates,
  );
  const result = materializeRootCauseMismatches(review, candidates);
  assert.deepEqual(
    result.map((entry) => entry.field),
    ["itemRate", "itemQuantity"],
  );
});
