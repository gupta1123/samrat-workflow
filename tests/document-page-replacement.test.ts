import assert from "node:assert/strict";
import { test } from "node:test";

import { PDFDocument } from "pdf-lib";

import {
  buildReplacedPacketFile,
  evaluateDocumentPageReplacementReview,
  resolveDocumentPageReplacementTarget,
} from "../src/server/document-page-replacement";

const quality = {
  sourceFileName: "packet.pdf",
  pageNumber: 4,
  documentId: "eway-1",
  issues: ["rotated"],
  approvalSafe: false,
  confidence: "high",
  reason: "The page is sideways.",
};

test("resolves an unreadable page from structured mismatch evidence", () => {
  const target = resolveDocumentPageReplacementTarget({
    processingMeta: { documentPageQuality: [quality] },
    mismatch: {
      field_name: "documentReadability",
      values_json: [
        {
          docId: "eway-1",
          value: "display text is not parsed",
          sourceFileName: "packet.pdf",
          pageNumber: 4,
        },
      ],
    },
  });
  assert.equal(target.sourceFileName, "packet.pdf");
  assert.equal(target.pageNumber, 4);
  assert.equal(target.documentId, "eway-1");
});

test("supports an older mismatch only when its structured quality target is unique", () => {
  const target = resolveDocumentPageReplacementTarget({
    processingMeta: { documentPageQuality: [quality] },
    mismatch: {
      field_name: "documentReadability",
      values_json: [{ docId: "eway-1", value: "legacy display text" }],
    },
  });
  assert.equal(target.pageNumber, 4);

  assert.throws(
    () =>
      resolveDocumentPageReplacementTarget({
        processingMeta: {
          documentPageQuality: [quality, { ...quality, pageNumber: 5 }],
        },
        mismatch: {
          field_name: "documentReadability",
          values_json: [{ docId: "eway-1", value: "ambiguous legacy text" }],
        },
      }),
    /could not be identified safely/,
  );
});

test("accepts only a high-confidence, readable replacement of the same page and transaction", () => {
  const accepted = evaluateDocumentPageReplacementReview(
    JSON.stringify({
      verdict: "accept",
      confidence: "high",
      sameDocumentPage: true,
      sameTransaction: true,
      readable: true,
      approvalSafe: true,
      detectedIssues: [],
      reason: "The same e-way bill page is clear and upright.",
    }),
  );
  assert.equal(accepted.decision, "accepted");

  const unsafe = evaluateDocumentPageReplacementReview(
    JSON.stringify({
      verdict: "accept",
      confidence: "high",
      sameDocumentPage: true,
      sameTransaction: true,
      readable: true,
      approvalSafe: true,
      detectedIssues: ["cropped"],
      reason: "The right edge is missing.",
    }),
  );
  assert.equal(unsafe.decision, "rejected");

  const uncertain = evaluateDocumentPageReplacementReview(
    JSON.stringify({
      verdict: "accept",
      confidence: "medium",
      sameDocumentPage: true,
      sameTransaction: null,
      readable: true,
      approvalSafe: true,
      detectedIssues: [],
      reason: "The transaction reference is not visible.",
    }),
  );
  assert.equal(uncertain.decision, "needs_review");
});

test("replaces only the selected PDF page and preserves packet order", async () => {
  const original = await PDFDocument.create();
  original.addPage([100, 200]);
  original.addPage([200, 100]);
  original.addPage([300, 400]);
  const replacement = await PDFDocument.create();
  replacement.addPage([500, 600]);

  const rebuilt = await buildReplacedPacketFile({
    originalBytes: new Uint8Array(await original.save()),
    originalName: "packet.pdf",
    originalMimeType: "application/pdf",
    replacementBytes: new Uint8Array(await replacement.save()),
    replacementMimeType: "application/pdf",
    pageNumber: 2,
  });
  const verified = await PDFDocument.load(rebuilt.bytes);

  assert.equal(rebuilt.fileName, "packet.pdf");
  assert.equal(rebuilt.mimeType, "application/pdf");
  assert.equal(verified.getPageCount(), 3);
  assert.deepEqual(verified.getPage(0).getSize(), { width: 100, height: 200 });
  assert.deepEqual(verified.getPage(1).getSize(), { width: 500, height: 600 });
  assert.deepEqual(verified.getPage(2).getSize(), { width: 300, height: 400 });
});
