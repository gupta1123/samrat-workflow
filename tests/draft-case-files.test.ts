import test from "node:test";
import assert from "node:assert/strict";
import { linkDraftCaseFiles } from "../src/lib/draft-case-files";
import type { QueuedUpload } from "../src/types/pipeline";

test("saved file ids are linked by the server-confirmed document name", () => {
  const uploads: QueuedUpload[] = [
    { id: "local-1", name: "Invoice.PDF", stages: [] },
    { id: "local-2", name: "weighment.pdf", stages: [] },
  ];
  const linked = linkDraftCaseFiles(uploads, [
    {
      id: "server-invoice",
      originalName: "invoice.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100,
      createdAt: "2026-09-10T08:00:00Z",
    },
  ]);

  assert.equal(linked[0].caseFileId, "server-invoice");
  assert.equal(linked[1].caseFileId, undefined);
  assert.notEqual(linked[0], uploads[0]);
});
