import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateMissingDocumentUploadReview,
  type MissingDocumentCandidate,
} from "../src/server/missing-document-upload";
import type { CaseDoc } from "../src/types/pipeline";

function candidate(
  name: string,
  type: CaseDoc["type"],
): MissingDocumentCandidate {
  return {
    sourceFileName: name,
    pageImages: [],
    documents: [
      {
        id: `${name}-doc`,
        type,
        title: type,
        pages: 1,
        fields: {},
        md: "",
        sourceFileName: name,
      },
    ],
  };
}

function review(files: Array<Record<string, unknown>>) {
  return JSON.stringify({ files });
}

test("admits only a high-confidence missing document from the same transaction", () => {
  const result = evaluateMissingDocumentUploadReview({
    candidates: [candidate("purchase-order.pdf", "Purchase Order")],
    missingGroups: ["Purchase Order", "Weight Proof"],
    rawReview: review([
      {
        sourceFileName: "purchase-order.pdf",
        verdict: "accept",
        confidence: "high",
        sameTransaction: true,
        detectedDocumentTypes: ["Purchase Order"],
        satisfiedMissingGroups: ["Purchase Order"],
        reason: "The PO reference and both parties match the invoice.",
      },
    ]),
  });

  assert.equal(result[0].decision, "accepted");
  assert.deepEqual(result[0].satisfiedMissingGroups, ["Purchase Order"]);
});

test("rejects an unrelated transaction and offers a separate case", () => {
  const result = evaluateMissingDocumentUploadReview({
    candidates: [candidate("other-invoice.pdf", "Tax Invoice")],
    missingGroups: ["Purchase Order", "Weight Proof"],
    rawReview: review([
      {
        sourceFileName: "other-invoice.pdf",
        verdict: "reject",
        confidence: "high",
        sameTransaction: false,
        detectedDocumentTypes: ["Tax Invoice"],
        satisfiedMissingGroups: [],
        reason: "This invoice has a different invoice number and vehicle.",
      },
    ]),
  });

  assert.equal(result[0].decision, "rejected");
  assert.equal(result[0].createNewCaseSuggested, true);
});

test("does not trust an accept verdict when the visible type fills no missing group", () => {
  const result = evaluateMissingDocumentUploadReview({
    candidates: [candidate("receipt.pdf", "Receipt")],
    missingGroups: ["Purchase Order", "Weight Proof"],
    rawReview: review([
      {
        sourceFileName: "receipt.pdf",
        verdict: "accept",
        confidence: "high",
        sameTransaction: true,
        detectedDocumentTypes: ["Receipt"],
        satisfiedMissingGroups: ["Purchase Order"],
        reason: "It belongs to the same company.",
      },
    ]),
  });

  assert.equal(result[0].decision, "rejected");
  assert.deepEqual(result[0].satisfiedMissingGroups, []);
});

test("keeps uncertain linkage outside the case", () => {
  const result = evaluateMissingDocumentUploadReview({
    candidates: [candidate("weight.pdf", "Weighment Slip")],
    missingGroups: ["Weight Proof"],
    rawReview: review([
      {
        sourceFileName: "weight.pdf",
        verdict: "uncertain",
        confidence: "medium",
        sameTransaction: null,
        detectedDocumentTypes: ["Weighment Slip"],
        satisfiedMissingGroups: ["Weight Proof"],
        reason: "The vehicle number is unreadable.",
      },
    ]),
  });

  assert.equal(result[0].decision, "needs_review");
  assert.equal(result[0].createNewCaseSuggested, false);
});

test("fails closed when the reviewer response is malformed", () => {
  assert.throws(
    () =>
      evaluateMissingDocumentUploadReview({
        candidates: [candidate("po.pdf", "Purchase Order")],
        missingGroups: ["Purchase Order"],
        rawReview: "not json",
      }),
    /returned no decision/,
  );
});
