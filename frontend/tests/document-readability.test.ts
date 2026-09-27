import assert from "node:assert/strict";
import { test } from "node:test";

import { DOCUMENT_READABILITY_FIELD } from "../src/lib/document-readability";
import {
  buildDocumentReadabilityMismatches,
  parseDocumentPageQuality,
} from "../src/server/document-readability";
import type { CaseDoc } from "../src/types/pipeline";

const document: CaseDoc = {
  id: "invoice-1",
  type: "Tax Invoice",
  title: "Invoice",
  pages: 1,
  fields: { invoiceNumber: "INV-1" },
  md: "## Visible Text\nInvoice INV-1",
  sourceFileName: "packet.pdf",
};

const sourcePages = [{ sourceFileName: "packet.pdf", pageNumber: 1 }];

test("a clear upright source page remains approval-safe", () => {
  const assessments = parseDocumentPageQuality({
    value: [
      {
        sourceFileName: "packet.pdf",
        pageNumber: 1,
        documentId: "invoice-1",
        issues: [],
        approvalSafe: true,
        confidence: "high",
        reason: "All critical values are clearly readable.",
      },
    ],
    sourcePages,
    documents: [document],
  });

  assert.equal(assessments.length, 1);
  assert.deepEqual(buildDocumentReadabilityMismatches(assessments), []);
});

for (const issue of ["faint", "rotated", "blurred", "cropped"] as const) {
  test(`a merely ${issue} source page does not create a review issue`, () => {
    const assessments = parseDocumentPageQuality({
      value: [
        {
          sourceFileName: "packet.pdf",
          pageNumber: 1,
          documentId: "invoice-1",
          issues: [issue],
          approvalSafe: false,
          confidence: "high",
          reason: `The page is materially ${issue}.`,
        },
      ],
      sourcePages,
      documents: [document],
    });
    assert.deepEqual(buildDocumentReadabilityMismatches(assessments), []);
  });
}

test("an unreadable source page creates a blocking review issue", () => {
  const assessments = parseDocumentPageQuality({
    value: [
      {
        sourceFileName: "packet.pdf",
        pageNumber: 1,
        documentId: "invoice-1",
        issues: ["unreadable"],
        approvalSafe: false,
        confidence: "high",
        reason: "The page cannot be read at all.",
      },
    ],
    sourcePages,
    documents: [document],
  });
  const mismatches = buildDocumentReadabilityMismatches(assessments);

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].field, DOCUMENT_READABILITY_FIELD);
  assert.equal(mismatches[0].values[0].docId, "invoice-1");
  assert.match(mismatches[0].analysis ?? "", /automatic approval/i);
});

test("page-quality review fails closed when a source page is omitted", () => {
  assert.throws(
    () =>
      parseDocumentPageQuality({
        value: [],
        sourcePages,
        documents: [document],
      }),
    /did not assess the readability of every source page/i,
  );
});

test("a page with a reading defect cannot be marked approval-safe", () => {
  assert.throws(
    () =>
      parseDocumentPageQuality({
        value: [
          {
            sourceFileName: "packet.pdf",
            pageNumber: 1,
            documentId: "invoice-1",
            issues: ["blurred"],
            approvalSafe: true,
            confidence: "medium",
            reason: "Critical text is blurred.",
          },
        ],
        sourcePages,
        documents: [document],
      }),
    /approval-safe/i,
  );
});
