import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { planUploadQueue, validateUploadFiles } from "../src/lib/upload-queue";
import { createScanDocument } from "../src/lib/client-scan-pdf";
const file = (name: string, text = "original") =>
  new File([text], name, { type: "application/pdf" });

test("same-name uploads prompt without replacing originals, including collisions in one selection", () => {
  const original = planUploadQueue([], [file("invoice.pdf")]).uploads;
  const plan = planUploadQueue(original, [
    file("INVOICE.pdf", "replacement"),
    file("receipt.pdf"),
    file("receipt.pdf", "second"),
  ]);
  assert.equal(plan.conflicts.length, 2);
  assert.equal(plan.uploads.length, 2);
  assert.equal(plan.uploads[0], original[0]);
  assert.equal(plan.acceptedUploads.length, 1);
  assert.equal(original.length, 1);
});
test("keep both assigns unique names across repeated collisions; overwrite preserves order and replaces bytes", async () => {
  const original = planUploadQueue(
    [],
    [file("invoice.pdf"), file("invoice (2).pdf"), file("receipt.pdf")],
  ).uploads;
  const duplicates = planUploadQueue(
    original,
    [file("Invoice.pdf"), file("invoice.pdf")],
    "duplicate",
  );
  assert.deepEqual(
    duplicates.acceptedUploads.map((u) => u.name),
    ["Invoice (3).pdf", "invoice (4).pdf"],
  );
  const replaced = planUploadQueue(
    original,
    [file("INVOICE.pdf", "corrected")],
    "overwrite",
  );
  assert.equal(replaced.uploads.length, 3);
  assert.equal(await replaced.uploads[0].file!.text(), "corrected");
  assert.equal(replaced.uploads[2], original[2]);
  assert.equal(await original[0].file!.text(), "original");
});
test("invalid, empty and over-limit selections are rejected without changing the queue", () => {
  const original = planUploadQueue([], [file("invoice.pdf")]).uploads;
  assert.throws(
    () => planUploadQueue(original, [file("payload.html")]),
    /Choose PDF/,
  );
  assert.throws(() => validateUploadFiles([file("empty.pdf", "")]), /Empty/);
  assert.throws(
    () =>
      planUploadQueue(
        original,
        Array.from({ length: 20 }, (_, i) => file(`page-${i}.pdf`)),
      ),
    /20 files/,
  );
  assert.equal(original.length, 1);
});
test("camera pages become one valid PDF in capture order with preserved aspect ratios", async () => {
  const makeImage = (w: number, h: number, color: string) => {
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    return new File(
      [new Uint8Array(canvas.toBuffer("image/png"))],
      `${color}.png`,
      { type: "image/png" },
    );
  };
  const result = await createScanDocument(
    [makeImage(100, 200, "red"), makeImage(300, 100, "blue")],
    "scan.pdf",
  );
  assert.equal(result.name, "scan.pdf");
  assert.equal(result.type, "application/pdf");
  const pdf = await PDFDocument.load(await result.arrayBuffer());
  assert.equal(pdf.getPageCount(), 2);
  assert.deepEqual(
    pdf.getPages().map((p) => p.getSize()),
    [
      { width: 100, height: 200 },
      { width: 300, height: 100 },
    ],
  );
  await assert.rejects(createScanDocument([], "empty"), /1 and 40/);
});
