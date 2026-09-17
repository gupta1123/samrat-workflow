import assert from "node:assert/strict";
import { test } from "node:test";

import { getDocumentIssueCount } from "../src/lib/document-review-status";

test("document status counts only issues linked to that uploaded document", () => {
  const count = getDocumentIssueCount(
    ["invoice-1", "Invoice"],
    [
      {
        id: "invoice-number",
        values: [{ docId: "invoice-1" }, { docId: "purchase-order-1" }],
      },
      {
        id: "document-reading",
        values: [{ docId: "invoice-1" }],
      },
      {
        id: "other-document",
        values: [{ docId: "lorry-receipt-1" }],
      },
    ],
  );

  assert.equal(count, 2);
});

test("packet-level missing-document warnings do not make an uploaded document incorrect", () => {
  const count = getDocumentIssueCount(
    ["invoice-1"],
    [
      {
        id: "missing-required-documents",
        values: [{ docId: "packet" }],
      },
    ],
  );

  assert.equal(count, 0);
});

test("authoritative attribution marks only the actual outlier document", () => {
  const mismatch = {
    id: "vehicle-number",
    values: [
      { docId: "invoice", isOutlier: false },
      { docId: "eway", isOutlier: true },
      { docId: "lorry", isOutlier: false },
    ],
  };

  assert.equal(getDocumentIssueCount(["invoice"], [mismatch]), 0);
  assert.equal(getDocumentIssueCount(["eway"], [mismatch]), 1);
  assert.equal(getDocumentIssueCount(["lorry"], [mismatch]), 0);
});
