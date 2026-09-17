export async function createScanDocument(
  files: File[],
  name: string,
): Promise<File> {
  if (!files.length || files.length > 40)
    throw new Error("Scan between 1 and 40 pages per document.");
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  for (const file of files) {
    let bytes = await file.arrayBuffer();
    let png = file.type === "image/png";
    if (!png && file.type !== "image/jpeg") {
      const bitmap = await createImageBitmap(file).catch(() => {
        throw new Error(
          `Unable to read ${file.name}. Use JPG or PNG for scanned pages.`,
        );
      });
      try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Unable to prepare this scan.");
        context.fillStyle = "white";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0);
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/jpeg", 0.92),
        );
        if (!blob) throw new Error("Unable to prepare this scan.");
        bytes = await blob.arrayBuffer();
        png = false;
      } finally {
        bitmap.close();
      }
    }
    const image = png ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const scale = Math.min(1, 842 / Math.max(image.width, image.height));
    const width = image.width * scale,
      height = image.height * scale;
    const page = pdf.addPage([width, height]);
    page.drawImage(image, { x: 0, y: 0, width, height });
  }
  const result = await pdf.save();
  return new File(
    [new Uint8Array(result)],
    name.replace(/(?:\.pdf)?$/i, ".pdf"),
    { type: "application/pdf" },
  );
}
