export const MAX_CASE_PAGE_COUNT = 40;

function pageLimitMessage(pageCount: number) {
  const excess = pageCount - MAX_CASE_PAGE_COUNT;
  return `These files contain ${pageCount} pages. A case can contain a maximum of ${MAX_CASE_PAGE_COUNT} pages. Remove at least ${excess} ${excess === 1 ? "page" : "pages"} and try again.`;
}

export async function countUploadPages(files: File[]) {
  const { PDFDocument } = await import("pdf-lib");
  let pageCount = 0;

  for (const file of files) {
    if (!/\.pdf$/i.test(file.name)) {
      pageCount += 1;
    } else {
      try {
        const pdf = await PDFDocument.load(await file.arrayBuffer(), {
          updateMetadata: false,
        });
        const pages = pdf.getPageCount();
        if (pages < 1) throw new Error("PDF has no pages");
        pageCount += pages;
      } catch {
        throw new Error(
          `We couldn't read the page count in "${file.name}". Check that it is a valid, unencrypted PDF and try again.`,
        );
      }
    }

    if (pageCount > MAX_CASE_PAGE_COUNT) {
      throw new Error(pageLimitMessage(pageCount));
    }
  }

  return pageCount;
}

export async function validateCasePageLimit(files: File[]) {
  return countUploadPages(files);
}
