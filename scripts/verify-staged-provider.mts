import fs from "node:fs";
import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import type { CaseDoc } from "../src/types/pipeline.ts";

if (fs.existsSync(".env.local")) process.loadEnvFile(".env.local");
const canvas = createCanvas(1200, 1600);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "white";
ctx.fillRect(0, 0, 1200, 1600);
ctx.fillStyle = "black";
ctx.font = "bold 36px Arial";
ctx.fillText("ASTER METALS PRIVATE LIMITED", 100, 130);
ctx.fillText("TAX INVOICE", 100, 220);
ctx.font = "28px Arial";
ctx.fillText("Supplier: ASTER METALS PRIVATE LIMITED", 100, 340);
ctx.fillText("Buyer: SAMRAT IRONS PRIVATE LIMITED", 100, 420);
ctx.fillText("Purchase Order: ORDER-27", 100, 510);
ctx.fillText("Invoice Number: __________________", 100, 600);
ctx.fillText("Authorized Signature", 100, 1170);
ctx.strokeStyle = "blue";
ctx.lineWidth = 4;
ctx.beginPath();
ctx.moveTo(120, 1300);
ctx.bezierCurveTo(270, 1180, 170, 1360, 320, 1260);
ctx.bezierCurveTo(380, 1220, 280, 1350, 470, 1290);
ctx.stroke();
const document: CaseDoc = {
  id: "synthetic-source",
  type: "Tax Invoice",
  title: "Tax Invoice",
  pages: 1,
  sourceFileName: "synthetic-provider-smoke.png",
  sourcePageNumbers: [1],
  fields: {
    vendorName: "ASTER METALS PRIVATE LIMITED",
    buyerName: "SAMRAT IRONS PRIVATE LIMITED",
    referencePoNumber: "ORDER-27",
    hasAuthorizedSignature: "No",
  },
  md: "Supplier: ASTER METALS PRIVATE LIMITED\nBuyer: SAMRAT IRONS PRIVATE LIMITED\nPurchase Order: ORDER-27\nInvoice Number:",
};
// Add independent synthetic pages, not copies of an uploaded/recycled packet.
// Page numbers deliberately differ from the task-local image position.
const extras: CaseDoc[] = [
  {
    id: "synthetic-po",
    type: "Purchase Order",
    title: "Purchase Order",
    pages: 1,
    sourceFileName: document.sourceFileName,
    sourcePageNumbers: [2],
    fields: {
      vendorName: "ASTER METALS PRIVATE LIMITED",
      buyerName: "SAMRAT IRONS PRIVATE LIMITED",
      poNumber: "ORDER-27",
    },
    md: "",
  },
  {
    id: "synthetic-eway",
    type: "E-Way Bill",
    title: "E-Way Bill",
    pages: 1,
    sourceFileName: document.sourceFileName,
    sourcePageNumbers: [3],
    fields: {
      vendorName: "ASTER METALS PRIVATE LIMITED",
      buyerName: "SAMRAT IRONS PRIVATE LIMITED",
      eWayBillNumber: "271948620583",
      vehicleNumber: "MH14KP7635",
    },
    md: "",
  },
  {
    id: "synthetic-weight",
    type: "Weighment Slip",
    title: "Weighment Slip",
    pages: 1,
    sourceFileName: document.sourceFileName,
    sourcePageNumbers: [4],
    fields: {
      vendorName: "ASTER METALS PRIVATE LIMITED",
      weighmentNumber: "WB-281",
      vehicleNumber: "MH14KP7635",
      grossWeight: "27.000 MT",
      tareWeight: "15.000 MT",
      netWeight: "12.000 MT",
    },
    md: "",
  },
  {
    id: "synthetic-lr",
    type: "Lorry Receipt",
    title: "Lorry Receipt",
    pages: 1,
    sourceFileName: document.sourceFileName,
    sourcePageNumbers: [5],
    fields: {
      vendorName: "ASTER METALS PRIVATE LIMITED",
      buyerName: "SAMRAT IRONS PRIVATE LIMITED",
      lorryReceiptNumber: "LR-281",
      vehicleNumber: "MH14KP7635",
    },
    md: "",
  },
  {
    id: "synthetic-delivery",
    type: "Delivery Challan",
    title: "Delivery Challan",
    pages: 1,
    sourceFileName: document.sourceFileName,
    sourcePageNumbers: [6],
    fields: {
      vendorName: "ASTER METALS PRIVATE LIMITED",
      buyerName: "SAMRAT IRONS PRIVATE LIMITED",
      deliveryNoteNumber: "DN-281",
      referencePoNumber: "ORDER-27",
      vehicleNumber: "MH14KP7635",
    },
    md: "",
  },
];
const labels: Record<string, string> = {
  vendorName: "Supplier",
  buyerName: "Buyer",
  poNumber: "Purchase Order",
  referencePoNumber: "Purchase Order",
  eWayBillNumber: "E-Way Bill Number",
  vehicleNumber: "Vehicle Number",
  weighmentNumber: "Weighment Number",
  grossWeight: "Gross Weight",
  tareWeight: "Tare Weight",
  netWeight: "Net Weight",
  lorryReceiptNumber: "Lorry Receipt Number",
  deliveryNoteNumber: "Delivery Challan Number",
};
const extraPages = extras.map((doc) => {
  const image = createCanvas(1200, 1600);
  const drawing = image.getContext("2d");
  drawing.fillStyle = "white";
  drawing.fillRect(0, 0, 1200, 1600);
  drawing.fillStyle = "black";
  drawing.font = "bold 36px Arial";
  drawing.fillText(doc.type.toUpperCase(), 80, 160);
  drawing.font = "25px Arial";
  const printed = {
    ...doc.fields,
    ...(doc.id === "synthetic-weight"
      ? { buyerName: "SAMRAT IRONS PRIVATE LIMITED" }
      : {}),
  };
  const lines = Object.entries(printed).map(
    ([field, value]) => `${labels[field]}: ${value}`,
  );
  lines.forEach((line, index) => drawing.fillText(line, 80, 300 + index * 95));
  doc.md = lines.join("\n");
  return {
    sourceFileName: doc.sourceFileName!,
    pageNumber: doc.sourcePageNumbers![0],
    image: image.toDataURL("image/png"),
  };
});
const { reviewExtractedDocumentsInStages } =
  await import("../src/server/processing/staged-review.ts");
const started = Date.now();
// Diagnostic capture is opt-in and only observes this script's fresh synthetic
// provider responses. Never enable response capture in the production worker.
if (process.env.SYNTHETIC_REVIEW_DEBUG === "1") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (String(args[0]).startsWith("https://openrouter.ai/")) {
      const body = await response.clone().json();
      console.log("SYNTHETIC_RESPONSE", body.choices?.[0]?.message?.content);
      if (body.error)
        console.log("SYNTHETIC_PROVIDER_ERROR", JSON.stringify(body.error));
    }
    return response;
  };
}
// Synthetic pixels only; no database, uploaded document, checkpoint or case
// decision is read/written. This checks real provider schema compatibility.
const result = await reviewExtractedDocumentsInStages([document, ...extras], {
  sourcePages: [
    {
      sourceFileName: document.sourceFileName!,
      pageNumber: 1,
      image: canvas.toDataURL("image/png"),
    },
    ...extraPages,
  ],
  onReviewStage: async (progress, stage) => {
    console.log(JSON.stringify({ progress, stage }));
  },
});
assert.equal(result.documents[0].fields.invoiceNumber, undefined);
assert.equal(result.documents[0].fields.hasAuthorizedSignature, "Yes");
assert.equal(result.authoritativeReview.documentAudits.length, 6);
assert.ok(result.pageQuality.every((page) => page.approvalSafe));
assert.equal(
  result.documents.find((doc) => doc.id === "synthetic-weight")?.fields
    .buyerName,
  "SAMRAT IRONS PRIVATE LIMITED",
);
assert.equal(result.authoritativeReview.mismatches.length, 0);
assert.equal(
  result.authoritativeReview.verificationGroups[0].caseSummary.counterpartyName,
  "ASTER METALS PRIVATE LIMITED",
);
assert.equal(
  result.authoritativeReview.verificationGroups[0].caseSummary.invoiceNumber,
  "",
);
console.log(
  JSON.stringify({
    syntheticProviderSmoke: "passed",
    totalMs: Date.now() - started,
    modelCalls: result.review.attemptCount,
    corrections: result.review.correctionCount,
    commercialMismatches: result.authoritativeReview.mismatches.length,
    pageWarnings: result.pageQuality.filter((page) => !page.approvalSafe)
      .length,
    caseDataUsed: false,
    caseDecisionWritten: false,
  }),
);
