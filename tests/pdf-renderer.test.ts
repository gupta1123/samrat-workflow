import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { PDFDocument, degrees } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { samplePdf } from "./pdf-fixture";
import {
  pdfTextPages,
  renderPdfPages,
  withPdfSource,
  loadPdf,
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

// Reference renderer from the pre-optimization implementation. Comparing its
// actual output catches changed pixels, encoding, scaling and page rotation.
async function originalSequentialImages(bytes: Uint8Array) {
  const pdf = await loadPdf(bytes);
  const images: Buffer[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const normal = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({
        scale: Math.min(160 / 72, 3200 / Math.max(normal.width, normal.height)),
      });
      const canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      try {
        await page.render({
          canvasContext: canvas.getContext(
            "2d",
          ) as unknown as CanvasRenderingContext2D,
          viewport,
        }).promise;
        images.push(canvas.toBuffer("image/png"));
      } finally {
        page.cleanup();
        canvas.width = 1;
        canvas.height = 1;
      }
    }
    return images;
  } finally {
    await pdf.destroy();
  }
}

test("bounded parallel preparation preserves the exact original PNG bytes and delivery order", async () => {
  const pdf = await PDFDocument.load(samplePdf(5));
  pdf.getPage(1).setRotation(degrees(90));
  pdf.getPage(2).setRotation(degrees(180));
  pdf.getPage(3).setRotation(degrees(270));
  pdf.getPage(4).setSize(842, 595);
  const raster = await sharp({
    create: { width: 620, height: 420, channels: 3, background: "#badcfe" },
  })
    .png()
    .toBuffer();
  const image = await pdf.embedPng(raster);
  pdf.getPage(4).drawImage(image, { x: 100, y: 100, width: 620, height: 420 });
  const bytes = await pdf.save();
  const expected = await originalSequentialImages(bytes);
  for (const concurrency of [1, 2, 4]) {
    const order: number[] = [];
    const actual = await renderPdfPages(
      bytes,
      40,
      async (image, page) => {
        order.push(page);
        await new Promise((resolve) => setImmediate(resolve));
        return Buffer.from(image);
      },
      { concurrency },
    );
    assert.deepEqual(order, [1, 2, 3, 4, 5]);
    assert.deepEqual(actual, expected);
  }
});

test("a failed downstream page drains preparation before closing the PDF", async () => {
  const delivered: number[] = [];
  await assert.rejects(
    renderPdfPages(
      samplePdf(5),
      40,
      async (_image, page) => {
        delivered.push(page);
        throw new Error("Orientation callback failed");
      },
      { concurrency: 2 },
    ),
    /Orientation callback failed/,
  );
  assert.deepEqual(delivered, [1]);
  const next = await renderPdfPages(
    samplePdf(2),
    40,
    async (_image, page) => page,
  );
  assert.deepEqual(next, [1, 2]);
});
