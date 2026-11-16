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
type PdfDocument = Awaited<ReturnType<typeof loadPdf>>;

async function renderPages<T>(
  pdf: PdfDocument,
  maxPages: number,
  onPage: (bytes: Uint8Array, page: number) => Promise<T>,
) {
  const images: T[] = [];
  checkPageLimit(pdf, maxPages);
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
    let bytes: Uint8Array;
    try {
      await page.render({
        canvasContext: canvas.getContext(
          "2d",
        ) as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      bytes = canvas.toBuffer("image/png");
    } finally {
      page.cleanup();
      canvas.width = 1;
      canvas.height = 1;
    }
    // The encoded PNG is independent; free native pixels before downstream AI work.
    images.push(await onPage(bytes, i));
  }
  return images;
}

function checkPageLimit(pdf: PdfDocument, maxPages: number) {
  if (pdf.numPages > maxPages)
    throw new Error(
      `Page limit exceeded: this PDF has ${pdf.numPages} pages; the limit is ${maxPages}. Split it into smaller cases.`,
    );
}

async function readTextPages(pdf: PdfDocument, maxPages: number) {
  const pages: string[] = [];
  checkPageLimit(pdf, maxPages);
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    try {
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((x) => ("str" in x ? x.str : ""))
          .filter(Boolean)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
      );
    } finally {
      page.cleanup();
    }
  }
  return pages;
}

type PdfSource = {
  textPages: (maxPages: number) => Promise<string[]>;
  renderPages: <T>(
    maxPages: number,
    onPage: (bytes: Uint8Array, page: number) => Promise<T>,
  ) => Promise<T[]>;
};

/** Read text and render once from the same PDF; release it before AI review. */
export async function withPdfSource<T>(
  data: Uint8Array,
  processSource: (source: PdfSource) => Promise<T>,
) {
  const pdf = await loadPdf(data);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await pdf.destroy();
  };
  try {
    return await processSource({
      textPages: (limit) => readTextPages(pdf, limit),
      renderPages: async (limit, onPage) => {
        try {
          return await renderPages(pdf, limit, onPage);
        } finally {
          await dispose();
        }
      },
    });
  } finally {
    await dispose();
  }
}

export function renderPdfPages<T>(
  data: Uint8Array,
  maxPages: number,
  onPage: (bytes: Uint8Array, page: number) => Promise<T>,
) {
  return withPdfSource(data, (source) => source.renderPages(maxPages, onPage));
}

export function pdfTextPages(data: Uint8Array, maxPages = 40) {
  return withPdfSource(data, (source) => source.textPages(maxPages));
}
