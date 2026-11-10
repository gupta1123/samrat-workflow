import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  pdfsFromGrpoArchive,
  readBoundedAttachment,
} from "../src/server/sap/grpo-attachments-api";
import { zipFixture } from "./helpers/zip-fixture";

const pdf = Buffer.from("%PDF-1.7\nunchanged source bytes");

test("GRPO ZIP imports original PDFs, ignores reports and keeps deterministic file hashes", async () => {
  const files = await pdfsFromGrpoArchive(
    zipFixture([
      { name: "z.PDF", bytes: pdf },
      { name: "report.rpt", bytes: Buffer.from("not an invoice") },
      { name: "invoices/a.pdf", bytes: pdf },
    ]),
  );
  assert.deepEqual(
    files.map((f) => f.name),
    ["a.pdf", "z.PDF"],
  );
  for (const file of files) {
    assert.deepEqual(file.bytes, pdf);
    assert.equal(file.sha256, createHash("sha256").update(pdf).digest("hex"));
  }
  const reordered = await pdfsFromGrpoArchive(
    zipFixture([
      { name: "invoices/a.pdf", bytes: pdf },
      { name: "z.PDF", bytes: pdf },
    ]),
  );
  assert.deepEqual(reordered, files);
});

test("ZIP rejects missing PDFs, invalid responses, unsafe names and duplicate filenames", async () => {
  await assert.rejects(
    pdfsFromGrpoArchive(zipFixture([{ name: "report.rpt", bytes: pdf }])),
    /No PDF/,
  );
  await assert.rejects(
    pdfsFromGrpoArchive(Buffer.from("<html>gateway error</html>")),
    /unreadable/,
  );
  for (const name of [
    "../escape.pdf",
    "/escape.pdf",
    "C:\\escape.pdf",
    "bad\0.pdf",
  ]) {
    await assert.rejects(
      pdfsFromGrpoArchive(zipFixture([{ name, bytes: pdf }])),
    );
  }
  await assert.rejects(
    pdfsFromGrpoArchive(
      zipFixture([
        { name: "folder/a.pdf", bytes: pdf },
        { name: "other/A.PDF", bytes: pdf },
      ]),
    ),
    /ambiguous/,
  );
});

test("ZIP rejects corrupt, encrypted or falsely labelled PDFs before they can be uploaded", async () => {
  await assert.rejects(
    pdfsFromGrpoArchive(
      zipFixture([{ name: "a.pdf", bytes: pdf, checksum: 0 }]),
    ),
    /damaged/,
  );
  await assert.rejects(
    pdfsFromGrpoArchive(zipFixture([{ name: "a.pdf", bytes: pdf, flags: 1 }])),
    /encrypted/,
  );
  await assert.rejects(
    pdfsFromGrpoArchive(
      zipFixture([{ name: "a.pdf", bytes: Buffer.from("<html>") }]),
    ),
    /did not return a PDF/,
  );
  await assert.rejects(
    pdfsFromGrpoArchive(
      zipFixture([{ name: "a.pdf", bytes: pdf, declaredSize: 1 }]),
    ),
    /unreadable|declared size/,
  );
});

test("ZIP enforces file-count and expanded-size limits before decompression", async () => {
  await assert.rejects(
    pdfsFromGrpoArchive(
      zipFixture(
        Array.from({ length: 21 }, (_, i) => ({
          name: `${i}.pdf`,
          bytes: pdf,
        })),
      ),
    ),
    /20 file/,
  );
  await assert.rejects(
    pdfsFromGrpoArchive(
      zipFixture([
        { name: "large.pdf", bytes: pdf, declaredSize: 51 * 1024 * 1024 },
      ]),
    ),
    /50 MB/,
  );
});

test("attachment downloads reject errors, redirects and oversized streamed responses", async () => {
  await assert.rejects(
    readBoundedAttachment(new Response(null, { status: 401 })),
    /HTTP 401/,
  );
  await assert.rejects(
    readBoundedAttachment(new Response(null, { status: 302 })),
    /HTTP 302/,
  );
  await assert.rejects(
    readBoundedAttachment(new Response(null, { status: 404 })),
    /No attachments/,
  );
  await assert.rejects(
    readBoundedAttachment(
      new Response("a", {
        headers: { "content-length": String(51 * 1024 * 1024) },
      }),
    ),
    /50 MB/,
  );
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(26 * 1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(readBoundedAttachment(new Response(stream)), /50 MB/);
  assert.equal(cancelled, true);
});
