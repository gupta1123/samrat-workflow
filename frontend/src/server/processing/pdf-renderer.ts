import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// PDF.js expects these browser primitives even in Node. Native canvas works in
// Netlify's Node runtime and removes the external pdftoppm/Poppler dependency.
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
class NativeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(
    target: ReturnType<NativeCanvasFactory["create"]>,
    width: number,
    height: number,
  ) {
    target.canvas.width = width;
    target.canvas.height = height;
  }
  destroy(target: ReturnType<NativeCanvasFactory["create"]>) {
    target.canvas.width = 1;
    target.canvas.height = 1;
  }
}
export async function loadPdf(data: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const root = path.resolve(process.cwd(), "node_modules/pdfjs-dist");
  const worker = path.join(root, "legacy/build/pdf.worker.mjs");
  if (!fs.existsSync(worker))
    throw new Error(
      "PDF worker was not bundled. Check Netlify included_files.",
    );
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(worker).href;
  return pdfjs.getDocument({
    data: data.slice(),
    isEvalSupported: false,
    useSystemFonts: false,
    CanvasFactory: NativeCanvasFactory,
    standardFontDataUrl: path.join(root, "standard_fonts") + path.sep,
    cMapUrl: path.join(root, "cmaps") + path.sep,
    cMapPacked: true,
  }).promise;
}
export async function renderPdfPages(
  data: Uint8Array,
  maxPages: number,
  onPage: (bytes: Uint8Array, page: number) => Promise<string>,
) {
  const pdf = await loadPdf(data);
  const images: string[] = [];
  try {
    if (pdf.numPages > maxPages)
      throw new Error(
        `Page limit exceeded: this PDF has ${pdf.numPages} pages; the limit is ${maxPages}. Split it into smaller cases.`,
      );
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const normal = page.getViewport({ scale: 1 });
      const scale = Math.min(
        160 / 72,
        3200 / Math.max(normal.width, normal.height),
      );
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      await page.render({
        canvasContext: canvas.getContext(
          "2d",
        ) as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      images.push(await onPage(canvas.toBuffer("image/png"), i));
      page.cleanup();
      canvas.width = 1;
      canvas.height = 1;
    }
  } finally {
    await pdf.destroy();
  }
  return images;
}
export async function pdfTextPages(data: Uint8Array, maxPages = 40) {
  const pdf = await loadPdf(data);
  const pages: string[] = [];
  try {
    if (pdf.numPages > maxPages)
      throw new Error(
        `Page limit exceeded: this PDF has ${pdf.numPages} pages; the limit is ${maxPages}. Split it into smaller cases.`,
      );
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((x) => ("str" in x ? x.str : ""))
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      );
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  return pages;
}
