export function samplePdf(pageCount = 1): Uint8Array {
  return samplePdfWithPageTexts(
    Array.from(
      { length: pageCount },
      (_, index) => `Samrat sample invoice page ${index + 1}`,
    ),
  );
}

export function samplePdfWithPageTexts(pageTexts: string[]): Uint8Array {
  const pageCount = pageTexts.length;
  const objects: string[] = [];
  const kids = Array.from(
    { length: pageCount },
    (_, i) => `${4 + i * 2} 0 R`,
  ).join(" ");
  objects.push(
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  );
  for (let i = 0; i < pageCount; i++) {
    const escapedPageText = pageTexts[i]
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
    const text = `BT /F1 20 Tf 50 700 Td (${escapedPageText}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
      .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf));
}
