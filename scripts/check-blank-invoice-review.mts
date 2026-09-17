// Integration smoke check: fully artificial document, no case/database reads.
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import sharp from "sharp";
import type { CaseDoc } from "../src/types/pipeline";
import { buildInvoiceNumberRequiredIssues } from "../src/lib/invoice-approval";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const { reviewAndCorrectExtractedDocuments } =
  await import("../src/server/processing/pipeline");
const text = [
  "Supplier: EXAMPLE STEEL",
  "TAX INVOICE",
  "Invoice number:",
  "Purchase Order: EXAMPLE-PO-001",
  "Buyer: Example Buyer",
  "Taxable value: 100.00",
  "IGST 18%: 18.00",
  "Total amount: 118.00",
];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><rect width="900" height="1200" fill="white"/>${text.map((line, index) => `<text x="65" y="${100 + index * 75}" font-family="Arial" font-size="30" fill="black">${line}</text>`).join("")}</svg>`;
const png = await sharp(Buffer.from(svg)).png().toBuffer();
const doc: CaseDoc = {
  id: "example-invoice",
  type: "Invoice",
  title: "Tax Invoice",
  pages: 1,
  sourceFileName: "artificial.pdf",
  sourceHint: "Pages 1-1",
  sourcePageNumbers: [1],
  fields: {
    vendorName: "EXAMPLE STEEL",
    buyerName: "Example Buyer",
    referencePoNumber: "EXAMPLE-PO-001",
    subtotal: "100.00",
    igstRate: "18",
    taxAmount: "18.00",
    totalAmount: "118.00",
  },
  md: `# Invoice\n\n## OCR Text\n\n${text.join("\n")}`,
};
const startedAt = Date.now();
const transportText = [
  "E-WAY BILL",
  "E-Way Bill No: 271948620583",
  "Document details: TAX INVOICE",
  "Supplier: EXAMPLE STEEL",
  "Buyer: Example Buyer",
];
const transportSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><rect width="900" height="1200" fill="white"/>${transportText.map((line, index) => `<text x="65" y="${100 + index * 75}" font-family="Arial" font-size="30" fill="black">${line}</text>`).join("")}</svg>`;
const transportPng = await sharp(Buffer.from(transportSvg)).png().toBuffer();
const transport: CaseDoc = {
  id: "example-transport",
  type: "E-Way Bill",
  title: "Transport record",
  pages: 1,
  sourceFileName: "artificial.pdf",
  sourcePageNumbers: [2],
  fields: {
    eWayBillNumber: "271948620583",
    referenceInvoiceNumber: "TAX INVOICE",
    vendorName: "EXAMPLE STEEL",
    buyerName: "Example Buyer",
  },
  md: `## Visible Text\n${transportText.join("\n")}`,
};
const reviewed = await reviewAndCorrectExtractedDocuments([doc, transport], {
  authoritativePacketReview: true,
  candidateMismatches: [],
  preliminaryVerificationGroups: [],
  sourcePages: [
    {
      sourceFileName: "artificial.pdf",
      pageNumber: 1,
      image: `data:image/png;base64,${png.toString("base64")}`,
    },
    {
      sourceFileName: "artificial.pdf",
      pageNumber: 2,
      image: `data:image/png;base64,${transportPng.toString("base64")}`,
    },
  ],
});
assert.ok(reviewed.authoritativeReview);
assert.equal(
  String(reviewed.documents[0].fields.invoiceNumber ?? "").trim(),
  "",
);
assert.equal(reviewed.documents[1].fields.referenceInvoiceNumber, undefined);
assert.equal(
  reviewed.authoritativeReview.verificationGroups[0].caseSummary
    .counterpartyName,
  "EXAMPLE STEEL",
);
assert.equal(reviewed.reviewIssues.length, 0);
const issues = buildInvoiceNumberRequiredIssues({
  invoiceNumber:
    reviewed.authoritativeReview.verificationGroups[0]?.caseSummary
      ?.invoiceNumber,
  documents: reviewed.documents.map((d) => ({
    id: d.id,
    documentType: d.type,
    invoiceNumber: d.fields.invoiceNumber,
  })),
  verificationGroups: reviewed.authoritativeReview.verificationGroups,
});
assert.equal(issues.length, 1);
assert.equal(issues[0].field, "invoiceNumberRequired");
console.log(
  JSON.stringify({
    scope: "artificial-blank-invoice-review",
    invoiceStayedBlank: true,
    mandatoryIssueCreated: true,
    documentTypeNotUsedAsReference: true,
    supplierTitleSourceVerified: true,
    reviewAttemptCount: reviewed.review.attemptCount,
    durationMs: Date.now() - startedAt,
    persisted: false,
    realDocumentsSent: false,
  }),
);
