import assert from "node:assert/strict";
import test from "node:test";

import {
  caseFileContentUrl,
  inlineCaseFileResponse,
} from "../src/server/case-files";

test("case previews use a stable same-origin authenticated URL", () => {
  assert.equal(
    caseFileContentUrl(
      "fef967bb-749f-4d3c-a4be-1b4dde5ebbac",
      "00000000-0000-4000-8000-000000000001",
    ),
    "/api/cases/fef967bb-749f-4d3c-a4be-1b4dde5ebbac/files?fileId=00000000-0000-4000-8000-000000000001&content=1",
  );
});

test("case preview responses are inline, private, and keep the PDF content type", async () => {
  const response = inlineCaseFileResponse(
    new Blob(["%PDF-fixture"], { type: "application/pdf" }),
    { originalName: "Dispatch Packet 2574.pdf", mimeType: "application/pdf" },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /^inline; filename\*=UTF-8''Dispatch%20Packet%202574\.pdf$/,
  );
  assert.equal(await response.text(), "%PDF-fixture");
});
