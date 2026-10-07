import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRequestFits,
  packRequestBatches,
  RequestSizeError,
} from "../src/server/processing/request-budget";
import {
  packetEvidenceBatches,
  validatePageEvidence,
  reviewRequestBody,
  pageEvidenceMessages,
  PAGE_EVIDENCE_SCHEMA,
} from "../src/server/processing/packet-evidence";

test("size is UTF-8 serialized bytes, not PDF bytes or character count", () => {
  const body = JSON.stringify({ text: "₹".repeat(100) });
  assert.equal(assertRequestFits(body, 1000), Buffer.byteLength(body));
  assert.throws(() => assertRequestFits(body, body.length), RequestSizeError);
});

test("packing covers every page once in order and rejects an oversized single page", () => {
  const items = ["a".repeat(30), "b".repeat(30), "c".repeat(30)];
  const batches = packRequestBatches(items, JSON.stringify, 70);
  assert.deepEqual(batches.flat(), items);
  assert.equal(batches.length, 2);
  for (const batch of batches)
    assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 70);
  assert.throws(
    () => packRequestBatches(["x".repeat(100)], JSON.stringify, 70),
    RequestSizeError,
  );
});

test("all image bytes, instructions and schema are counted in evidence batches", () => {
  const pages = Array.from({ length: 6 }, (_, index) => ({
    sourceFileName: "scan.pdf",
    pageNumber: index + 1,
    image: "data:image/jpeg;base64," + "a".repeat(3_000_000),
  }));
  const batches = packetEvidenceBatches(pages);
  assert.deepEqual(
    batches.flat().map((page) => page.pageNumber),
    [1, 2, 3, 4, 5, 6],
  );
  assert.ok(batches.length > 1);
  for (const batch of batches)
    assert.ok(
      Buffer.byteLength(
        reviewRequestBody(
          pageEvidenceMessages(batch),
          PAGE_EVIDENCE_SCHEMA,
          16384,
        ),
      ) <= 8_000_000,
    );
});

test("page evidence rejects missing/duplicate/invented pointers and empty transcriptions", () => {
  const pages = [
    {
      sourceFileName: "file.pdf",
      pageNumber: 1,
      image: "image",
      pointer: "p1",
    },
  ];
  const entry = { pointer: "p1", evidence: "Invoice INV-1", readable: true };
  assert.deepEqual(
    validatePageEvidence(JSON.stringify({ pages: [entry] }), pages),
    [entry],
  );
  for (const entries of [
    [],
    [entry, entry],
    [{ ...entry, pointer: "p2" }],
    [{ ...entry, evidence: "" }],
  ]) {
    assert.throws(() =>
      validatePageEvidence(JSON.stringify({ pages: entries }), pages),
    );
  }
});
