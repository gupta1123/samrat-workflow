import assert from "node:assert/strict";
import { test } from "node:test";

import { DOCUMENT_READABILITY_FIELD } from "../src/lib/document-readability";
import { EXTRACTION_VERIFICATION_FIELD } from "../src/lib/extraction-verification";
import { INVOICE_NUMBER_REQUIRED_FIELD } from "../src/lib/invoice-approval";
import { MISSING_DOCUMENTS_FIELD } from "../src/lib/missing-documents";
import { isAlwaysVisibleReviewIssue } from "../src/lib/mismatch-visibility";

test("blocking review issues are never hidden from the mismatch page", () => {
  assert.equal(isAlwaysVisibleReviewIssue(DOCUMENT_READABILITY_FIELD), true);
  assert.equal(isAlwaysVisibleReviewIssue(EXTRACTION_VERIFICATION_FIELD), true);
  assert.equal(isAlwaysVisibleReviewIssue(INVOICE_NUMBER_REQUIRED_FIELD), true);
  assert.equal(isAlwaysVisibleReviewIssue(MISSING_DOCUMENTS_FIELD), true);
  assert.equal(isAlwaysVisibleReviewIssue("internalDebugValue"), false);
});
