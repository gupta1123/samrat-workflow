import assert from "node:assert/strict";
import test from "node:test";

import { samplePdfWithPageTexts } from "./pdf-fixture";

test("one-case analysis still extracts distinct documents from a PDF", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });

  t.mock.method(
    globalThis,
    "fetch",
    async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ content?: string }>;
      };
      const requestText = JSON.stringify(body.messages ?? []);
      const isPurchaseOrder = requestText.includes(
        "This document is a Purchase Order",
      );
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                fields: isPurchaseOrder
                  ? { poNumber: "PO-100" }
                  : { invoiceNumber: "INV-100" },
                lineItems: [],
                visibleText: isPurchaseOrder
                  ? "PURCHASE ORDER PO No PO-100"
                  : "TAX INVOICE Invoice No INV-100",
              }),
            },
          },
        ],
      });
    },
  );

  const { extractPdfPacketDocuments } =
    await import("../src/server/processing/pipeline");
  const bytes = samplePdfWithPageTexts([
    "PURCHASE ORDER - PO No PO-100",
    "TAX INVOICE - Invoice No INV-100",
  ]);
  const { pdfTextPages } =
    await import("../src/server/processing/pdf-renderer");
  const textPages = await pdfTextPages(bytes);
  const result = await extractPdfPacketDocuments({
    bytes,
    fileName: "one-case-packet.pdf",
    textPages,
  });

  assert.deepEqual(
    result.documents.map((document) => document.type),
    ["Purchase Order", "Tax Invoice"],
  );
  assert.equal(result.documents[0].fields.poNumber, "PO-100");
  assert.equal(result.documents[1].fields.invoiceNumber, "INV-100");
  assert.equal(result.reviewImages.length, 2);
});
