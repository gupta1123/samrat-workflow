/** Document length is not the source packet's page count. Unknown counts must
 * not force a document starting later in a packet back to its first page. */
export function pdfPreviewPage(
  requested: number | null,
  sourceStart: number,
  sourcePageCount: number,
) {
  const page = Math.max(1, requested ?? sourceStart);
  return sourcePageCount > 0 ? Math.min(page, sourcePageCount) : page;
}

let runtime:
  Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | undefined;
export function loadPdfPreviewRuntime() {
  runtime ??= import("pdfjs-dist/legacy/build/pdf.mjs").catch((error) => {
    runtime = undefined;
    throw error;
  });
  return runtime;
}
