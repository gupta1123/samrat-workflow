import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { PDFDocument, degrees } from "pdf-lib";
import { samplePdf } from "./pdf-fixture";
import {
  pdfTextPages,
  renderPdfPages,
  withPdfSource,
} from "../src/server/processing/pdf-renderer";
test("PDF text and native rendering handle all pages without Poppler", async () => {
  const bytes = samplePdf(2);
  const pages = await pdfTextPages(bytes);
  assert.equal(pages.length, 2);
  assert.match(pages[1], /page 2/);
  const rendered = await renderPdfPages(bytes, 40, async (image) => {
    const meta = await sharp(image).metadata();
    assert.ok((meta.width || 0) > 1000);
    const stats = await sharp(image).stats();
    assert.ok(
      stats.channels.some((c) => c.stdev > 1),
      "Rendered page must contain visible text, not a blank image.",
    );
    return `data:image/png;base64,${Buffer.from(image).toString("base64")}`;
  });
  assert.equal(rendered.length, 2);
  assert.ok(rendered.every((x) => x.length > 1000));
});
test("PDF limit rejects the whole file instead of silently skipping later pages", async () => {
  await assert.rejects(
    () => pdfTextPages(samplePdf(2), 1),
    /Page limit exceeded/,
  );
  await assert.rejects(
    () => renderPdfPages(samplePdf(2), 1, async () => ""),
    /Page limit exceeded/,
  );
});

test("reusing the PDF for text and images preserves every page, including sideways pages", async () => {
  const pdf = await PDFDocument.load(samplePdf(3));
  pdf.getPage(1).setRotation(degrees(90));
  pdf.getPage(2).setRotation(degrees(180));
  const input = await pdf.save();
  const capture = async (bytes: Uint8Array, page: number) => ({ page, bytes });
  const separate = {
    text: await pdfTextPages(input),
    images: await renderPdfPages(input, 40, capture),
  };
  const combined = await withPdfSource(input, async (source) => ({
    text: await source.textPages(40),
    images: await source.renderPages(40, capture),
  }));
  assert.deepEqual(combined, separate);
});
