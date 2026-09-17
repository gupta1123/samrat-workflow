import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaseDoc } from "../src/types/pipeline";

const sourceFileName = "dispatch.pdf";
const documents: CaseDoc[] = [
  {
    id: "invoice",
    type: "Tax Invoice",
    title: "Invoice",
    pages: 1,
    sourceFileName,
    sourcePageNumbers: [1],
    fields: {
      vendorName: "Aster Metals",
      buyerName: "Foundry Purchaser",
      referencePoNumber: "ORDER-27",
    },
    md: "Supplier Aster Metals. Buyer Foundry Purchaser. PO ORDER-27. Invoice number:",
  },
  {
    id: "eway",
    type: "E-Way Bill",
    title: "Transport",
    pages: 1,
    sourceFileName,
    sourcePageNumbers: [2],
    fields: {
      eWayBillNumber: "271948620583",
      referenceInvoiceNumber: "TAX INVOICE",
    },
    md: "Document Details: TAX INVOICE. E-Way Bill No: 271948620583",
  },
];
const proof = (
  field: string,
  value: string,
  sourceLabel: string,
  pageNumber: number,
) => ({
  field,
  value,
  sourceLabel,
  valueKind: "reference",
  sourceFileName,
  pageNumber,
  quote: `${sourceLabel}: ${value}`,
});

test("one value-and-proof ledger adds a newly seen vehicle and removes a document type without redundant status votes", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });
  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const valueAndProof = (
    field: string,
    value: string,
    label: string,
    page: number,
  ) => {
    const { field: ignored, ...entry } = proof(field, value, label, page);
    void ignored;
    return entry;
  };
  let badProof = false;
  let buyerSource = false;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    const base = responsePayload("correct");
    const { verdict: ignored, ...withoutVerdict } = base;
    void ignored;
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              ...withoutVerdict,
              packetGroups: base.packetGroups.map((group) => {
                const { counterpartyName: ignoredName, ...summary } =
                  group.caseSummary;
                void ignoredName;
                return {
                  ...group,
                  caseSummary: {
                    ...summary,
                    counterpartySource: {
                      docId: "invoice",
                      field: buyerSource ? "buyerName" : "vendorName",
                    },
                  },
                };
              }),
              sourceSupport: {
                invoice: {
                  fieldSupport: {
                    vendorName: "supported",
                    buyerName: "supported",
                  },
                  lineItemPropertySupport: {},
                },
                eway: { fieldSupport: {}, lineItemPropertySupport: {} },
              },
              documentAudits: base.documentAudits.map((audit) => ({
                docId: audit.docId,
                sourceVerdict: "verified",
                visibleOmittedFields: [],
                reason: audit.reason,
              })),
              referenceReviews: [
                {
                  docId: "invoice",
                  fields: {
                    referencePoNumber: valueAndProof(
                      "referencePoNumber",
                      "ORDER-27",
                      "PO",
                      1,
                    ),
                    vehicleNumber: {
                      ...valueAndProof(
                        "vehicleNumber",
                        "RJ14PX6110",
                        "Vehicle",
                        1,
                      ),
                      ...(badProof ? { quote: "Vehicle:" } : {}),
                    },
                  },
                },
                {
                  docId: "eway",
                  fields: {
                    eWayBillNumber: valueAndProof(
                      "eWayBillNumber",
                      "271948620583",
                      "E-Way Bill No",
                      2,
                    ),
                    referenceInvoiceNumber: {
                      value: null,
                      sourceLabel: "Document Details",
                      valueKind: "document_type",
                      sourceFileName,
                      pageNumber: 2,
                      quote: "Document Details: TAX INVOICE",
                    },
                  },
                },
              ],
            }),
          },
        },
      ],
    });
  });
  const run = () =>
    reviewAndCorrectExtractedDocuments(documents, {
      authoritativePacketReview: true,
      sourcePages: documents.map((_, i) => ({
        sourceFileName,
        pageNumber: i + 1,
        image: "data:image/png;base64,fixture",
      })),
    });
  const result = await run();
  assert.equal(calls, 1);
  assert.equal(result.documents[0].fields.vehicleNumber, "RJ14PX6110");
  assert.equal(result.documents[1].fields.referenceInvoiceNumber, undefined);
  assert.equal(
    result.authoritativeReview?.verificationGroups[0].caseSummary
      .counterpartyName,
    "Aster Metals",
  );
  assert.deepEqual(
    result.authoritativeReview?.documentAudits.map(({ status }) => status),
    ["corrected", "corrected"],
  );
  assert.ok(
    result.authoritativeReview?.documentAudits[0].referenceEvidence.some(
      ({ field }) => field === "vehicleNumber",
    ),
  );
  badProof = true;
  calls = 0;
  await assert.rejects(run, /Invalid semantic reference evidence/);
  assert.equal(calls, 2);
  badProof = false;
  buyerSource = true;
  calls = 0;
  await assert.rejects(run, /not bound to a reviewed external-party field/);
  assert.equal(calls, 2);
});

test("generated source checklists require one verdict per original field without introducing blank fields", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });
  const {
    buildReviewSourceSupportChecklist,
    buildAuthoritativeReviewResponseSchema,
    reviewAndCorrectExtractedDocuments,
  } = await import("../src/server/processing/pipeline");
  const schema = buildAuthoritativeReviewResponseSchema({
    documents,
    documentCount: 2,
    mismatchCount: 0,
    pageCount: 2,
  });
  const properties = schema.properties as Record<
    string,
    Record<string, unknown>
  >;
  const maps = buildReviewSourceSupportChecklist(documents);
  assert.deepEqual(maps.invoice.fieldSupport, ["vendorName", "buyerName"]);
  assert.equal(maps.invoice.fieldSupport.includes("invoiceNumber"), false);
  assert.ok(properties.sourceSupport);
  assert.ok(properties.referenceReviews);
  assert.equal(properties.verdict, undefined);
  let incomplete = false;
  t.mock.method(globalThis, "fetch", async () => {
    const base = responsePayload("correct");
    const sourceSupport = Object.fromEntries(
      documents.map((doc) => [
        doc.id,
        {
          fieldSupport: Object.fromEntries(
            Object.keys(doc.fields).map((field) => [
              field,
              field === "referenceInvoiceNumber" ? "unsupported" : "supported",
            ]),
          ),
          lineItemPropertySupport: {},
        },
      ]),
    );
    if (incomplete) delete sourceSupport.invoice.fieldSupport.buyerName;
    const documentAudits = base.documentAudits.map((audit) =>
      Object.fromEntries(
        Object.entries(audit).filter(
          ([key]) =>
            ![
              "supportedFields",
              "unsupportedFields",
              "supportedLineItemProperties",
              "unsupportedLineItemProperties",
            ].includes(key),
        ),
      ),
    );
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({ ...base, sourceSupport, documentAudits }),
          },
        },
      ],
    });
  });
  const run = () =>
    reviewAndCorrectExtractedDocuments(documents, {
      authoritativePacketReview: true,
      sourcePages: documents.map((_, i) => ({
        sourceFileName,
        pageNumber: i + 1,
        image: "data:image/png;base64,fixture",
      })),
    });
  assert.equal((await run()).review.attemptCount, 1);
  incomplete = true;
  await assert.rejects(run, /Missing: buyerName/);
});

test("source omissions require a populated value; physically blank fields cannot masquerade as OCR omissions", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });
  let printed = false;
  t.mock.method(globalThis, "fetch", async () => {
    const base = responsePayload("correct");
    const value = printed ? "INV-PRINTED-27" : "";
    const evidence = {
      sourceFileName,
      pageNumber: 1,
      quote: printed ? `Invoice No: ${value}` : "Invoice No:",
    };
    const payload = {
      ...base,
      corrections: [
        ...base.corrections,
        {
          docId: "invoice",
          fields: [{ field: "invoiceNumber", value }],
          evidence,
          reason: "Restore an actually printed source value.",
        },
      ],
      documentAudits: base.documentAudits.map((audit) =>
        audit.docId === "invoice"
          ? {
              ...audit,
              status: "corrected",
              visibleOmittedFields: [
                { field: "invoiceNumber", value, evidence },
              ],
              referenceEvidence: [
                ...audit.referenceEvidence,
                ...(printed
                  ? [proof("invoiceNumber", value, "Invoice No", 1)]
                  : []),
              ],
            }
          : audit,
      ),
      packetGroups: base.packetGroups.map((group) => ({
        ...group,
        caseSummary: {
          ...group.caseSummary,
          invoiceNumber: printed ? value : "",
          primaryReference: printed ? value : "ORDER-27",
        },
      })),
    };
    return Response.json({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    });
  });
  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const run = () =>
    reviewAndCorrectExtractedDocuments(documents, {
      authoritativePacketReview: true,
      sourcePages: documents.map((_, index) => ({
        sourceFileName,
        pageNumber: index + 1,
        image: "data:image/png;base64,fixture",
      })),
    });
  await assert.rejects(
    run,
    /blank, absent and unreadable fields are not printed omissions/,
  );
  printed = true;
  const result = await run();
  assert.equal(result.documents[0].fields.invoiceNumber, "INV-PRINTED-27");
  assert.equal(result.review.attemptCount, 1);
});

function responsePayload(variant: "correct" | "wrong-type" | "wrong-title") {
  const corrected = variant !== "wrong-type";
  return {
    verdict: corrected ? "corrected" : "pass",
    corrections: corrected
      ? [
          {
            docId: "eway",
            unsetFields: ["referenceInvoiceNumber"],
            evidence: {
              sourceFileName,
              pageNumber: 2,
              quote: "Document Details: TAX INVOICE",
            },
            reason:
              "The words identify a document type, not an invoice reference.",
          },
        ]
      : [],
    reviewIssues: [],
    documentAudits: [
      {
        docId: "invoice",
        status: "verified",
        supportedFields: ["vendorName", "buyerName", "referencePoNumber"],
        unsupportedFields: [],
        visibleOmittedFields: [],
        supportedLineItemProperties: [],
        unsupportedLineItemProperties: [],
        referenceEvidence: [proof("referencePoNumber", "ORDER-27", "PO", 1)],
        reason:
          "Printed supplier, buyer and PO are distinct roles; the invoice number is blank.",
      },
      {
        docId: "eway",
        status: corrected ? "corrected" : "verified",
        supportedFields: corrected
          ? ["eWayBillNumber"]
          : ["eWayBillNumber", "referenceInvoiceNumber"],
        unsupportedFields: corrected ? ["referenceInvoiceNumber"] : [],
        visibleOmittedFields: [],
        supportedLineItemProperties: [],
        unsupportedLineItemProperties: [],
        referenceEvidence: [
          proof("eWayBillNumber", "271948620583", "E-Way Bill No", 2),
          ...(!corrected
            ? [
                {
                  ...proof(
                    "referenceInvoiceNumber",
                    "TAX INVOICE",
                    "Document Details",
                    2,
                  ),
                  valueKind: "document_type",
                },
              ]
            : []),
        ],
        reason:
          "Read the document category separately from identifying numbers.",
      },
    ],
    mismatchDecisions: [],
    termsChecklist: [],
    notes: [],
    packetGroups: [
      {
        label: "Aster Metals / ORDER-27",
        documentIds: ["invoice", "eway"],
        relationship: "standard",
        primaryDocumentIds: [],
        contextDocumentIds: [],
        rationale: "Supplier's invoice and associated transport page.",
        caseSummary: {
          counterpartyName:
            variant === "wrong-title" ? "Foundry Purchaser" : "Aster Metals",
          counterpartySource: {
            docId: "invoice",
            field: variant === "wrong-title" ? "buyerName" : "vendorName",
          },
          poNumber: "ORDER-27",
          invoiceNumber: "",
          primaryReference: "ORDER-27",
          packetCategory: "Procurement packet",
        },
      },
    ],
    pageQuality: documents.map((doc, index) => ({
      sourceFileName,
      pageNumber: index + 1,
      documentId: doc.id,
      issues: [],
      approvalSafe: true,
      confidence: "high",
      reason: "Upright, clear printed page.",
    })),
  };
}

test("a source-grounded review removes a document type from invoice references and binds the supplier title", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });
  let calls = 0;
  let variant: "correct" | "wrong-type" | "wrong-title" = "correct";
  let firstRequest = "";
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: unknown, init?: RequestInit) => {
      calls++;
      firstRequest ||= String(init?.body);
      return Response.json({
        choices: [
          { message: { content: JSON.stringify(responsePayload(variant)) } },
        ],
      });
    },
  );
  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const run = () =>
    reviewAndCorrectExtractedDocuments(documents, {
      authoritativePacketReview: true,
      sourcePages: documents.map((_, index) => ({
        sourceFileName,
        pageNumber: index + 1,
        image: "data:image/png;base64,fixture",
      })),
    });
  const result = await run();
  assert.equal(calls, 1);
  assert.equal(result.documents[1].fields.referenceInvoiceNumber, undefined);
  assert.equal(result.documents[0].fields.invoiceNumber, undefined);
  assert.equal(
    result.authoritativeReview?.verificationGroups[0].caseSummary
      .counterpartyName,
    "Aster Metals",
  );
  assert.equal(result.reviewIssues.length, 0);
  assert.ok(firstRequest.includes("referenceFieldDefinitions"));
  assert.ok(firstRequest.includes("sourcePageNumbers"));
  for (const bad of ["wrong-type", "wrong-title"] as const) {
    variant = bad;
    calls = 0;
    await assert.rejects(
      run,
      bad === "wrong-type"
        ? /Invalid semantic reference evidence/
        : /not bound to a reviewed external-party field/,
    );
    assert.equal(calls, 2);
  }
});
