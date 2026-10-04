import assert from "node:assert/strict";
import { test } from "node:test";
import { pdfPreviewPage } from "../src/lib/pdf-preview";

test("all six single-page documents keep their actual page in one PDF packet", () => {
  for (let start = 1; start <= 6; start++) {
    assert.equal(pdfPreviewPage(null, start, 6), start);
  }
});

test("a source whose page count has not loaded can open a later document", () => {
  assert.equal(pdfPreviewPage(null, 4, 0), 4);
  assert.equal(pdfPreviewPage(5, 4, 0), 5);
  assert.equal(pdfPreviewPage(null, 1, 0), 1);
});

test("manual navigation stays in the loaded source and resets to the newly selected document", () => {
  assert.equal(pdfPreviewPage(5, 2, 6), 5);
  assert.equal(pdfPreviewPage(null, 2, 6), 2);
  assert.equal(pdfPreviewPage(null, 4, 2), 2);
  assert.equal(pdfPreviewPage(0, 2, 6), 1);
});
