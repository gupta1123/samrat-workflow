import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { DocType } from "../src/types/pipeline";
import { samplePdfWithPageTexts } from "./pdf-fixture";

type SequencePage = {
  documentType: DocType;
  startsNewDocument: boolean;
  boundaryEvidence: string;
  extractionSource?: "image" | "text";
};

function pageRecord(page: SequencePage, pageNumber: number) {
  return {
    pageNumber,
    startsNewDocument: page.startsNewDocument,
    boundaryEvidence: page.boundaryEvidence,
    extractionSource: page.extractionSource ?? "text",
    documents: [
      {
        documentType: page.documentType,
        confidence: 0.99,
      },
    ],
  };
}

function extractionResponse(requestText: string) {
  if (requestText.includes("This document is a Purchase Order")) {
    return {
      fields: { poNumber: "PO-100" },
      lineItems: [],
      visibleText: "PURCHASE ORDER PO No PO-100",
    };
  }
  if (requestText.includes("This document is a Tax Invoice")) {
    return {
      fields: {
        invoiceNumber: "INV-100",
        totalAmount: "1180",
        taxableAmount: "1000",
      },
      lineItems: [
        {
          description: "Steel item",
          quantity: 1,
          unit: "MT",
          rate: 1000,
          amount: 1000,
        },
      ],
      visibleText: "TAX INVOICE Invoice No INV-100 Total 1180",
    };
  }
  if (requestText.includes("This document is a Weighment Slip")) {
    return {
      fields: { netWeight: "41800 KG" },
      lineItems: [],
      visibleText: "WEIGHMENT SLIP NET WEIGHT 41800 KG",
    };
  }
  if (requestText.includes("This document is a Lorry Receipt")) {
    return {
      fields: { lorryReceiptNumber: "LR-212" },
      lineItems: [],
      visibleText: "LORRY RECEIPT LR-212",
    };
  }
  if (requestText.includes("This document is a E-Way Bill")) {
    return {
      fields: { ewayBillNumber: "102459820757" },
      lineItems: [],
      visibleText: "E-WAY BILL 102459820757",
    };
  }
  return {
    fields: { documentNumber: "MTC-100" },
    lineItems: [],
    visibleText: "MATERIAL TEST CERTIFICATE MTC-100",
  };
}

function mockPacketAi(t: TestContext, sequence: SequencePage[]) {
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
        response_format?: {
          json_schema?: {
            name?: string;
          };
        };
      };
      const requestText = JSON.stringify(body.messages ?? []);
      const requestedPage = Number(
        requestText.match(/Current global page: (\d+)/)?.[1],
      );
      const content =
        body.response_format?.json_schema?.name === "pdf_page_sequence_entry"
          ? pageRecord(sequence[requestedPage - 1], requestedPage)
          : extractionResponse(requestText);
      return Response.json({
        choices: [{ message: { content: JSON.stringify(content) } }],
      });
    },
  );
}

test("one-case analysis extracts distinct documents from a PDF", async (t) => {
  mockPacketAi(t, [
    {
      documentType: "Purchase Order",
      startsNewDocument: true,
      boundaryEvidence: "First page",
    },
    {
      documentType: "Tax Invoice",
      startsNewDocument: true,
      boundaryEvidence: "A new headed invoice form starts on this page.",
    },
  ]);

  const { extractPdfPacketDocuments } =
    await import("../src/server/processing/pipeline");
  const bytes = samplePdfWithPageTexts([
    "PURCHASE ORDER - PO No PO-100",
    "TAX INVOICE - Invoice No INV-100",
  ]);
  const { pdfTextPages } =
    await import("../src/server/processing/pdf-renderer");
  const result = await extractPdfPacketDocuments({
    bytes,
    fileName: "one-case-packet.pdf",
    textPages: await pdfTextPages(bytes),
  });

  assert.deepEqual(
    result.documents.map((document) => document.type),
    ["Purchase Order", "Tax Invoice"],
  );
  assert.equal(result.documents[0].fields.poNumber, "PO-100");
  assert.equal(result.documents[1].fields.invoiceNumber, "INV-100");
  assert.equal(result.reviewImages.length, 2);
});

test("six unlike packet pages stay six independent documents", async (t) => {
  const sequence: SequencePage[] = [
    "Tax Invoice",
    "Weighment Slip",
    "Material Test Certificate",
    "Lorry Receipt",
    "Purchase Order",
    "E-Way Bill",
  ].map((documentType, index) => ({
    documentType: documentType as DocType,
    startsNewDocument: true,
    boundaryEvidence:
      index === 0
        ? "First page"
        : "A new independently headed form starts here.",
  }));
  mockPacketAi(t, sequence);

  const { extractPdfPacketDocuments } =
    await import("../src/server/processing/pipeline");
  const bytes = samplePdfWithPageTexts([
    "TAX INVOICE Invoice No INV-100",
    "WEIGHMENT SLIP NET WEIGHT 41800 KG",
    "MATERIAL TEST CERTIFICATE MTC-100",
    "LORRY RECEIPT LR-212",
    "PURCHASE ORDER PO No PO-100",
    "E-WAY BILL 102459820757",
  ]);
  const { pdfTextPages } =
    await import("../src/server/processing/pdf-renderer");
  const result = await extractPdfPacketDocuments({
    bytes,
    fileName: "merged-packet.pdf",
    textPages: await pdfTextPages(bytes),
  });

  assert.deepEqual(
    result.documents.map((document) => document.type),
    sequence.map((page) => page.documentType),
  );
  assert.deepEqual(
    result.documents.map((document) => document.sourcePageNumbers),
    [[1], [2], [3], [4], [5], [6]],
  );
  assert.equal(result.documents[0].lineItems?.length, 1);
});

test("pages merge only when visual continuation is explicitly confirmed", async (t) => {
  mockPacketAi(t, [
    {
      documentType: "Purchase Order",
      startsNewDocument: true,
      boundaryEvidence: "First page",
    },
    {
      documentType: "Purchase Order",
      startsNewDocument: false,
      boundaryEvidence: "Page 2 of 2 continues the same item table.",
    },
    {
      documentType: "Tax Invoice",
      startsNewDocument: true,
      boundaryEvidence: "A new independently headed invoice starts here.",
    },
  ]);

  const { extractPdfPacketDocuments } =
    await import("../src/server/processing/pipeline");
  const bytes = samplePdfWithPageTexts([
    "PURCHASE ORDER PO-100 Page 1 of 2",
    "PURCHASE ORDER PO-100 Page 2 of 2 continued item table",
    "TAX INVOICE INV-100",
  ]);
  const { pdfTextPages } =
    await import("../src/server/processing/pdf-renderer");
  const result = await extractPdfPacketDocuments({
    bytes,
    fileName: "continued-po.pdf",
    textPages: await pdfTextPages(bytes),
  });

  assert.deepEqual(
    result.documents.map((document) => document.type),
    ["Purchase Order", "Tax Invoice"],
  );
  assert.deepEqual(result.documents[0].sourcePageNumbers, [1, 2]);
  assert.deepEqual(result.documents[1].sourcePageNumbers, [3]);
});

test("a malformed sequence response falls back to isolated pages", async (t) => {
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
        response_format?: { json_schema?: { name?: string } };
      };
      const requestText = JSON.stringify(body.messages ?? []);
      const content =
        body.response_format?.json_schema?.name === "pdf_page_sequence_entry"
          ? {}
          : requestText.includes("Classify rendered page")
            ? {
                documents: [
                  {
                    documentType: "Purchase Order",
                    confidence: 0.95,
                    documentNumber: null,
                    primaryPartyName: null,
                    vehicleNumber: null,
                    splitReason: null,
                  },
                ],
              }
            : extractionResponse(requestText);
      return Response.json({
        choices: [{ message: { content: JSON.stringify(content) } }],
      });
    },
  );

  const { extractPdfPacketDocuments } =
    await import("../src/server/processing/pipeline");
  const bytes = samplePdfWithPageTexts([
    "PURCHASE ORDER PO-100",
    "PURCHASE ORDER PO-101",
  ]);
  const { pdfTextPages } =
    await import("../src/server/processing/pdf-renderer");
  const result = await extractPdfPacketDocuments({
    bytes,
    fileName: "two-orders.pdf",
    textPages: await pdfTextPages(bytes),
  });

  assert.deepEqual(
    result.documents.map((document) => document.sourcePageNumbers),
    [[1], [2]],
  );
});
