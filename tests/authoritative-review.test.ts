import assert from "node:assert/strict";
import { test } from "node:test";

import type { CaseDoc } from "../src/types/pipeline";
import { mockGroundedReview } from "./grounded-review-fixture";

type VerifiedDocumentAuditFixture = {
  docId: string;
  supportedFields: string[];
  supportedLineItemProperties?: string[];
};

function verifiedDocumentAudits(...fixtures: VerifiedDocumentAuditFixture[]) {
  return fixtures.map((fixture) => ({
    docId: fixture.docId,
    status: "verified",
    supportedFields: fixture.supportedFields,
    unsupportedFields: [],
    visibleOmittedFields: [],
    supportedLineItemProperties: fixture.supportedLineItemProperties ?? [],
    unsupportedLineItemProperties: [],
    reason: "Every extracted value is supported by this document's source.",
  }));
}

test("authoritative review owns packet roles, terms, mismatches, and final fields", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousSetting = process.env.PACKET_EXTRACTION_REVIEW_ENABLED;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  process.env.PACKET_EXTRACTION_REVIEW_ENABLED = "true";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    if (previousSetting === undefined)
      delete process.env.PACKET_EXTRACTION_REVIEW_ENABLED;
    else process.env.PACKET_EXTRACTION_REVIEW_ENABLED = previousSetting;
  });

  let requestBody: Record<string, unknown> = {};
  let authoritativeRequestBody: Record<string, unknown> = {};
  let calls = 0;
  mockGroundedReview(
    t,
    async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      requestBody = JSON.parse(String(init?.body ?? "{}"));
      if (calls === 1) authoritativeRequestBody = requestBody;
      if (calls > 1) {
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  correctionDecisions: [
                    {
                      mutationId: "correction-1:field:taxAmount",
                      verdict: "accept",
                      reason:
                        "The page shows taxable and total amounts but no separately printed tax amount.",
                      evidence: {
                        sourceFileName: "packet.pdf",
                        pageNumber: 4,
                        quote:
                          "Taxable Amount 1890000 Total Invoice Amount 2230200",
                      },
                    },
                  ],
                  pageQuality: [
                    {
                      sourceFileName: "packet.pdf",
                      pageNumber: 4,
                      documentId: "eway",
                      issues: [],
                      approvalSafe: true,
                      confidence: "high",
                      reason:
                        "The page is upright and all critical values are clearly readable.",
                    },
                  ],
                }),
              },
            },
          ],
        });
      }
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: "needs_review",
                corrections: [
                  {
                    docId: "eway",
                    fields: [{ field: "taxAmount", value: null }],
                    evidence: {
                      sourceFileName: "packet.pdf",
                      pageNumber: 4,
                      quote:
                        "Taxable Amount 1890000 Total Invoice Amount 2230200",
                    },
                    reason:
                      "The page prints taxable and total values but no extracted tax amount.",
                  },
                ],
                reviewIssues: [
                  {
                    field: "invoiceNumber",
                    evidence: [
                      { docId: "buyer", value: "INVENTED-REVIEW-999" },
                    ],
                    reason: "Unsupported reviewer uncertainty.",
                  },
                ],
                documentAudits: [
                  ...verifiedDocumentAudits(
                    { docId: "po", supportedFields: ["poNumber"] },
                    {
                      docId: "mother",
                      supportedFields: [
                        "invoiceNumber",
                        "vendorName",
                        "buyerName",
                      ],
                    },
                    {
                      docId: "buyer",
                      supportedFields: [
                        "invoiceNumber",
                        "vendorName",
                        "buyerName",
                      ],
                    },
                    {
                      docId: "lr",
                      supportedFields: ["referenceInvoiceNumber"],
                    },
                  ),
                  {
                    docId: "eway",
                    status: "corrected",
                    supportedFields: [
                      "referenceInvoiceNumber",
                      "subtotal",
                      "totalAmount",
                    ],
                    unsupportedFields: ["taxAmount"],
                    visibleOmittedFields: [],
                    supportedLineItemProperties: [],
                    unsupportedLineItemProperties: [],
                    reason:
                      "The extracted tax amount is not printed on the E-Way Bill page.",
                  },
                ],
                mismatchDecisions: [],
                termsChecklist: [
                  {
                    sourceDocId: "po",
                    sourceClause:
                      "Material test certificate and statutory transport documents must accompany vehicle.",
                    obligation:
                      "Include the material test certificate in the packet.",
                    category: "Document requirement",
                    status: "not_fulfilled",
                    evidenceDocIds: [],
                    evidence: "No material test certificate is present.",
                    reason: "The required certificate is absent.",
                    severity: "medium",
                  },
                  {
                    sourceDocId: "po",
                    sourceClause:
                      "Material test certificate and statutory transport documents must accompany vehicle.",
                    obligation:
                      "Include statutory transport documents in the packet.",
                    category: "Document requirement",
                    status: "fulfilled",
                    evidenceDocIds: ["eway", "lr"],
                    evidence:
                      "The packet contains an E-Way Bill and Lorry Receipt.",
                    reason: "Both transport documents are present.",
                    severity: "none",
                  },
                ],
                packetGroups: [
                  {
                    label: "PO-TEST-017 seller chain",
                    documentIds: ["po", "mother", "buyer", "eway", "lr"],
                    relationship: "seller_chain",
                    primaryDocumentIds: ["buyer"],
                    contextDocumentIds: ["mother"],
                    rationale:
                      "The upstream invoice bills Bridge, while the primary invoice bills Samrat.",
                    caseSummary: {
                      counterpartyName: "Bridge Metals",
                      poNumber: "PO-TEST-017",
                      invoiceNumber: "BMT-017",
                      primaryReference: "BMT-017",
                      packetCategory: "Procurement packet",
                    },
                  },
                ],
                pageQuality: [
                  {
                    sourceFileName: "packet.pdf",
                    pageNumber: 4,
                    documentId: "eway",
                    issues: [],
                    approvalSafe: true,
                    confidence: "high",
                    reason:
                      "The page is upright and all critical values are clearly readable.",
                  },
                ],
                notes: [],
              }),
            },
          },
        ],
      });
    },
  );

  const documents: CaseDoc[] = [
    {
      id: "po",
      type: "Purchase Order",
      title: "Purchase Order",
      pages: 1,
      fields: { poNumber: "PO-TEST-017" },
      md: "## Visible Text\nMaterial test certificate and statutory transport documents must accompany vehicle.",
      sourceFileName: "packet.pdf",
    },
    {
      id: "mother",
      type: "Tax Invoice",
      title: "Upstream invoice",
      pages: 1,
      fields: {
        invoiceNumber: "TSM-4481",
        vendorName: "Test Steel",
        buyerName: "Bridge Metals",
      },
      md: "## Visible Text\nTest Steel\nBill To Bridge Metals\nInvoice TSM-4481",
      sourceFileName: "packet.pdf",
    },
    {
      id: "buyer",
      type: "Tax Invoice",
      title: "Buyer-facing invoice",
      pages: 1,
      fields: {
        invoiceNumber: "BMT-017",
        vendorName: "Bridge Metals",
        buyerName: "Samrat Group",
      },
      md: "## Visible Text\nBridge Metals\nBill To Samrat Group\nInvoice BMT-017",
      sourceFileName: "packet.pdf",
    },
    {
      id: "eway",
      type: "E-Way Bill",
      title: "E-Way Bill",
      pages: 1,
      fields: {
        referenceInvoiceNumber: "BMT-017",
        subtotal: "1890000",
        taxAmount: "340200",
        totalAmount: "2230200",
      },
      md: "## Visible Text\nTaxable Amount 1890000 Total Invoice Amount 2230200",
      sourceFileName: "packet.pdf",
    },
    {
      id: "lr",
      type: "Lorry Receipt",
      title: "Lorry Receipt",
      pages: 1,
      fields: { referenceInvoiceNumber: "BMT-017" },
      md: "## Visible Text\nLorry Receipt LR-017 for BMT-017",
      sourceFileName: "packet.pdf",
    },
  ];

  const {
    buildAuthoritativeTermsComplianceResult,
    reviewAndCorrectExtractedDocuments,
  } = await import("../src/server/processing/pipeline");
  const result = await reviewAndCorrectExtractedDocuments(documents, {
    candidateDocumentIds: documents.map((doc) => doc.id),
    candidateMismatches: [],
    preliminaryVerificationGroups: [],
    sourcePages: [
      {
        sourceFileName: "packet.pdf",
        pageNumber: 4,
        image: "data:image/png;base64,fixture",
      },
    ],
    authoritativePacketReview: true,
  });

  assert.equal(result.documents[3].fields.taxAmount, undefined);
  assert.equal(result.reviewIssues.length, 0);
  assert.equal(result.review.authoritative, true);
  assert.equal(result.review.independentPageQualityReview, false);
  assert.equal(result.review.verifiedCorrectionMutationCount, 1);
  assert.equal(result.review.semanticPostProcessing, false);
  assert.equal(result.review.verdict, "needs_review");
  assert.equal(result.authoritativeReview?.documentAudits.length, 5);
  assert.deepEqual(
    result.authoritativeReview?.documentAudits.map((audit) => audit.docId),
    ["po", "mother", "buyer", "lr", "eway"],
  );
  assert.equal(result.authoritativeReview?.verificationGroups.length, 1);
  assert.equal(
    result.authoritativeReview?.verificationGroups[0].roleSelection?.strategy,
    "seller_chain",
  );
  assert.deepEqual(
    result.authoritativeReview?.verificationGroups[0].roleSelection
      ?.primaryDocumentIds,
    ["buyer"],
  );

  const terms = buildAuthoritativeTermsComplianceResult(
    result.documents,
    result.authoritativeReview?.termsChecklist ?? [],
  );
  assert.equal(terms.checklist.length, 2);
  assert.equal(terms.mismatches.length, 1);
  assert.match(
    terms.mismatches[0].values.map((value) => value.value).join(" "),
    /material test certificate/i,
  );
  assert.doesNotMatch(
    String(terms.mismatches[0].analysis),
    /transport documents.*absent/i,
  );

  const messages = requestBody.messages as Array<{
    content: string | Array<{ type: string; image_url?: { url: string } }>;
  }>;
  assert.ok(Array.isArray(messages[1].content));
  assert.ok(
    (messages[1].content as Array<{ type: string }>).some(
      (part) => part.type === "image_url",
    ),
  );
  const systemPrompt = String(messages[0].content);
  assert.match(systemPrompt, /each document as its own source ledger/i);
  assert.match(systemPrompt, /must never populate a field on a document/i);
  assert.match(systemPrompt, /do not carry invoice tax rates or amounts/i);
  assert.match(systemPrompt, /invoice number is mandatory/i);
  assert.equal(
    (authoritativeRequestBody.response_format as { type: string }).type,
    "json_schema",
  );
  assert.equal(
    (
      authoritativeRequestBody.response_format as {
        json_schema: { strict: boolean };
      }
    ).json_schema.strict,
    true,
  );
  assert.deepEqual(authoritativeRequestBody.provider, {
    require_parameters: true,
  });
});

test("a verified audit with no-op correction records does not replay the full review", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });
  let calls = 0;
  let realChange = false;
  let repairIncludesPreviousResponse = false;
  mockGroundedReview(
    t,
    async (_input: string | URL | Request, init?: RequestInit) => {
      calls++;
      if (calls === 2) {
        const body = JSON.parse(String(init?.body));
        repairIncludesPreviousResponse = body.messages.some(
          (message: { role: string; content: unknown }) =>
            message.role === "assistant" &&
            String(message.content).includes("Different Supplier"),
        );
      }
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: realChange ? "corrected" : "pass",
                corrections: [
                  {
                    docId: "invoice",
                    documentType: "Invoice",
                    fields: [
                      realChange
                        ? { field: "vendorName", value: "Different Supplier" }
                        : { field: "invoiceNumber", value: null },
                    ],
                    evidence: {
                      sourceFileName: "artificial.pdf",
                      pageNumber: 1,
                      quote: "Invoice number:",
                    },
                    reason: "The number cell is blank.",
                  },
                ],
                reviewIssues: [],
                documentAudits: verifiedDocumentAudits({
                  docId: "invoice",
                  supportedFields: ["vendorName"],
                }),
                mismatchDecisions: [],
                termsChecklist: [],
                packetGroups: [
                  {
                    label: "Example Steel",
                    documentIds: ["invoice"],
                    relationship: "standard",
                    primaryDocumentIds: [],
                    contextDocumentIds: [],
                    rationale: "One invoice.",
                    caseSummary: {
                      counterpartyName: "Example Steel",
                      poNumber: "",
                      invoiceNumber: "",
                      primaryReference: "",
                      packetCategory: "Procurement packet",
                    },
                  },
                ],
                pageQuality: [
                  {
                    sourceFileName: "artificial.pdf",
                    pageNumber: 1,
                    documentId: "invoice",
                    issues: [],
                    approvalSafe: true,
                    confidence: "high",
                    reason: "All printed text is readable.",
                  },
                ],
                notes: [],
              }),
            },
          },
        ],
      });
    },
  );
  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const runReview = () =>
    reviewAndCorrectExtractedDocuments(
      [
        {
          id: "invoice",
          type: "Invoice",
          title: "Invoice",
          pages: 1,
          sourceFileName: "artificial.pdf",
          sourceHint: "Pages 1-1",
          fields: { vendorName: "Example Steel" },
          md: "Invoice number: blank. Supplier: Example Steel",
        },
      ],
      {
        authoritativePacketReview: true,
        candidateMismatches: [],
        sourcePages: [
          {
            sourceFileName: "artificial.pdf",
            pageNumber: 1,
            image: "data:image/png;base64,fixture",
          },
        ],
      },
    );
  const result = await runReview();
  assert.equal(calls, 1);
  assert.equal(result.review.attemptCount, 1);
  assert.equal(result.documents[0].fields.invoiceNumber, undefined);
  assert.equal(
    result.authoritativeReview?.documentAudits[0].status,
    "verified",
  );
  realChange = true;
  calls = 0;
  await assert.rejects(runReview, /verified while also returning changes/);
  assert.equal(calls, 2);
  assert.equal(repairIncludesPreviousResponse, true);
});

test("authoritative review fails closed when packet decisions are incomplete", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });

  let calls = 0;
  mockGroundedReview(t, async () => {
    calls += 1;
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict: "pass",
              corrections: [],
              reviewIssues: [],
              mismatchDecisions: [],
              termsChecklist: [],
              packetGroups: [],
            }),
          },
        },
      ],
    });
  });

  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  await assert.rejects(
    reviewAndCorrectExtractedDocuments(
      [
        {
          id: "invoice",
          type: "Tax Invoice",
          title: "Invoice",
          pages: 1,
          fields: { invoiceNumber: "INV-1" },
          md: "## Visible Text\nInvoice INV-1",
        },
      ],
      { authoritativePacketReview: true },
    ),
    /Required extraction review failed after 2 attempts/,
  );
  assert.equal(calls, 2);
});

test("authoritative review turns a faint page into a blocking mismatch", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });

  let calls = 0;
  mockGroundedReview(t, async () => {
    calls += 1;
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify(
              calls === 1
                ? {
                    verdict: "needs_review",
                    corrections: [],
                    reviewIssues: [],
                    documentAudits: [
                      {
                        ...verifiedDocumentAudits({
                          docId: "invoice",
                          supportedFields: ["invoiceNumber", "vendorName"],
                        })[0],
                        status: "needs_review",
                        reason:
                          "The source is too faint for approval-safe verification.",
                      },
                    ],
                    mismatchDecisions: [],
                    termsChecklist: [],
                    packetGroups: [
                      {
                        label: "Supplier / INV-1",
                        documentIds: ["invoice"],
                        relationship: "standard",
                        primaryDocumentIds: ["invoice"],
                        contextDocumentIds: [],
                        rationale: "The packet contains one supplier invoice.",
                        caseSummary: {
                          counterpartyName: "Supplier",
                          poNumber: "",
                          invoiceNumber: "INV-1",
                          primaryReference: "INV-1",
                          packetCategory: "Procurement packet",
                        },
                      },
                    ],
                    pageQuality: [
                      {
                        sourceFileName: "faint-invoice.pdf",
                        pageNumber: 1,
                        documentId: "invoice",
                        issues: ["faint"],
                        approvalSafe: false,
                        confidence: "high",
                        reason:
                          "Critical invoice values are too faint to verify reliably.",
                      },
                    ],
                    notes: [],
                  }
                : {
                    correctionDecisions: [],
                    pageQuality: [
                      {
                        sourceFileName: "faint-invoice.pdf",
                        pageNumber: 1,
                        documentId: "invoice",
                        issues: ["faint"],
                        approvalSafe: false,
                        confidence: "high",
                        reason:
                          "Critical invoice values are too faint to verify reliably.",
                      },
                    ],
                  },
            ),
          },
        },
      ],
    });
  });

  const { DOCUMENT_READABILITY_FIELD } =
    await import("../src/lib/document-readability");
  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const result = await reviewAndCorrectExtractedDocuments(
    [
      {
        id: "invoice",
        type: "Tax Invoice",
        title: "Invoice",
        pages: 1,
        fields: { invoiceNumber: "INV-1", vendorName: "Supplier" },
        md: "## Visible Text\nSupplier Invoice INV-1",
        sourceFileName: "faint-invoice.pdf",
      },
    ],
    {
      sourcePages: [
        {
          sourceFileName: "faint-invoice.pdf",
          pageNumber: 1,
          image: "data:image/png;base64,fixture",
        },
      ],
      authoritativePacketReview: true,
    },
  );

  assert.equal(result.review.verdict, "needs_review");
  assert.equal(result.pageQuality[0].approvalSafe, false);
  assert.equal(result.reviewIssues.length, 1);
  assert.equal(result.reviewIssues[0].field, DOCUMENT_READABILITY_FIELD);
  assert.match(result.reviewIssues[0].fixPlan ?? "", /clear, upright scan/i);
});

test("independent review preserves exact identifiers and catches quality missed by the first reviewer", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousIndependentReview =
    process.env.PACKET_INDEPENDENT_REVIEW_ENABLED;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  process.env.PACKET_INDEPENDENT_REVIEW_ENABLED = "true";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    if (previousIndependentReview === undefined)
      delete process.env.PACKET_INDEPENDENT_REVIEW_ENABLED;
    else
      process.env.PACKET_INDEPENDENT_REVIEW_ENABLED = previousIndependentReview;
  });

  let calls = 0;
  mockGroundedReview(t, async () => {
    calls += 1;
    const content =
      calls === 1
        ? {
            verdict: "corrected",
            corrections: [
              {
                docId: "eway",
                fields: { lorryReceiptNumber: "LRHD/0912" },
                evidence: {
                  sourceFileName: "packet.pdf",
                  pageNumber: 1,
                  quote: "Lorry Receipt LR/HD/0912",
                },
                reason: "Corrected the lorry receipt number.",
              },
            ],
            reviewIssues: [],
            documentAudits: [
              {
                ...verifiedDocumentAudits({
                  docId: "eway",
                  supportedFields: [
                    "referenceInvoiceNumber",
                    "lorryReceiptNumber",
                  ],
                })[0],
                status: "corrected",
                reason:
                  "The lorry receipt identifier requires a source correction.",
              },
              ...verifiedDocumentAudits({
                docId: "weighment",
                supportedFields: ["referenceInvoiceNumber"],
              }),
            ],
            mismatchDecisions: [],
            termsChecklist: [],
            packetGroups: [
              {
                label: "Supplier / INV-1",
                documentIds: ["eway", "weighment"],
                relationship: "standard",
                primaryDocumentIds: [],
                contextDocumentIds: [],
                rationale: "Both documents belong to invoice INV-1.",
                caseSummary: {
                  counterpartyName: "Supplier",
                  poNumber: "PO-1",
                  invoiceNumber: "INV-1",
                  primaryReference: "INV-1",
                  packetCategory: "Procurement packet",
                },
              },
            ],
            pageQuality: [
              {
                sourceFileName: "packet.pdf",
                pageNumber: 1,
                documentId: "eway",
                issues: [],
                approvalSafe: true,
                confidence: "high",
                reason: "The page is clear and upright.",
              },
              {
                sourceFileName: "packet.pdf",
                pageNumber: 2,
                documentId: "weighment",
                issues: [],
                approvalSafe: true,
                confidence: "high",
                reason: "The page is clear and upright.",
              },
            ],
            notes: [],
          }
        : {
            correctionDecisions: [
              {
                mutationId: "correction-1:field:lorryReceiptNumber",
                verdict: "keep_original",
                reason:
                  "The source visibly includes both slash separators, so the proposed value is less accurate.",
                evidence: {
                  sourceFileName: "packet.pdf",
                  pageNumber: 1,
                  quote: "Lorry Receipt LR/HD/0912",
                },
              },
            ],
            pageQuality: [
              {
                sourceFileName: "packet.pdf",
                pageNumber: 1,
                documentId: "eway",
                issues: [],
                approvalSafe: true,
                confidence: "high",
                reason: "The page is clear and upright.",
              },
              {
                sourceFileName: "packet.pdf",
                pageNumber: 2,
                documentId: "weighment",
                issues: ["faint"],
                approvalSafe: false,
                confidence: "high",
                reason:
                  "The pale text lacks enough contrast for safe visual verification.",
              },
            ],
          };
    return Response.json({
      choices: [{ message: { content: JSON.stringify(content) } }],
    });
  });

  const { DOCUMENT_READABILITY_FIELD } =
    await import("../src/lib/document-readability");
  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const result = await reviewAndCorrectExtractedDocuments(
    [
      {
        id: "eway",
        type: "E-Way Bill",
        title: "E-Way Bill",
        pages: 1,
        fields: {
          referenceInvoiceNumber: "INV-1",
          lorryReceiptNumber: "LR/HD/0912",
        },
        md: "## Visible Text\nInvoice INV-1\nLorry Receipt LR/HD/0912",
        sourceFileName: "packet.pdf",
      },
      {
        id: "weighment",
        type: "Weighment Slip",
        title: "Weighment Slip",
        pages: 1,
        fields: { referenceInvoiceNumber: "INV-1" },
        md: "## Visible Text\nInvoice INV-1\nNet weight 10,000 kg",
        sourceFileName: "packet.pdf",
      },
    ],
    {
      sourcePages: [
        {
          sourceFileName: "packet.pdf",
          pageNumber: 1,
          image: "data:image/png;base64,eway",
        },
        {
          sourceFileName: "packet.pdf",
          pageNumber: 2,
          image: "data:image/png;base64,weighment",
        },
      ],
      authoritativePacketReview: true,
    },
  );

  assert.equal(calls, 2);
  assert.equal(result.documents[0].fields.lorryReceiptNumber, "LR/HD/0912");
  assert.equal(result.review.verifiedCorrectionMutationCount, 0);
  assert.equal(result.review.rejectedCorrectionMutationCount, 1);
  assert.equal(result.pageQuality[1].approvalSafe, false);
  assert.deepEqual(result.pageQuality[1].issues, ["faint"]);
  assert.equal(result.reviewIssues.length, 1);
  assert.equal(result.reviewIssues[0].field, DOCUMENT_READABILITY_FIELD);
  assert.equal(result.review.verdict, "needs_review");
});

test("authoritative review uses stable short aliases for candidate mismatch decisions", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });

  const internalMismatchId =
    "packet-group-1-mismatch-vehicleNumber-1789023498568-95e09140c11";
  let requestText = "";
  mockGroundedReview(
    t,
    async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{
          role?: string;
          content?: string | Array<{ type?: string; text?: string }>;
        }>;
      };
      const userContent = body.messages?.find(
        (message) => message.role === "user",
      )?.content;
      requestText = Array.isArray(userContent)
        ? String(userContent.find((part) => part.type === "text")?.text ?? "")
        : String(userContent ?? "");
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: "needs_review",
                corrections: [],
                reviewIssues: [],
                documentAudits: verifiedDocumentAudits(
                  {
                    docId: "invoice",
                    supportedFields: ["invoiceNumber", "vehicleNumber"],
                  },
                  {
                    docId: "eway",
                    supportedFields: [
                      "referenceInvoiceNumber",
                      "vehicleNumber",
                    ],
                  },
                ),
                mismatchDecisions: [
                  {
                    mismatchId: "mismatch-1",
                    status: "confirmed",
                    primary: true,
                    outlierDocumentIds: ["eway"],
                    reason:
                      "The two source pages print different vehicle numbers.",
                  },
                ],
                termsChecklist: [],
                packetGroups: [
                  {
                    label: "Vardhan Steel / VS-1948",
                    documentIds: ["invoice", "eway"],
                    relationship: "standard",
                    primaryDocumentIds: ["invoice"],
                    contextDocumentIds: [],
                    rationale: "Both documents refer to invoice VS-1948.",
                    caseSummary: {
                      counterpartyName: "Vardhan Steel",
                      poNumber: "",
                      invoiceNumber: "VS-1948",
                      primaryReference: "VS-1948",
                      packetCategory: "Procurement packet",
                    },
                  },
                ],
                pageQuality: [
                  {
                    sourceFileName: "packet.pdf",
                    pageNumber: 1,
                    documentId: "invoice",
                    issues: [],
                    approvalSafe: true,
                    confidence: "high",
                    reason: "The page is clear and upright.",
                  },
                  {
                    sourceFileName: "packet.pdf",
                    pageNumber: 2,
                    documentId: "eway",
                    issues: [],
                    approvalSafe: true,
                    confidence: "high",
                    reason: "The page is clear and upright.",
                  },
                ],
                notes: [],
              }),
            },
          },
        ],
      });
    },
  );

  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const result = await reviewAndCorrectExtractedDocuments(
    [
      {
        id: "invoice",
        type: "Tax Invoice",
        title: "Tax Invoice",
        pages: 1,
        fields: {
          invoiceNumber: "VS-1948",
          vehicleNumber: "TS08UC4721",
        },
        md: "## Visible Text\nInvoice VS-1948\nVehicle TS08UC4721",
        sourceFileName: "packet.pdf",
      },
      {
        id: "eway",
        type: "E-Way Bill",
        title: "E-Way Bill",
        pages: 1,
        fields: {
          referenceInvoiceNumber: "VS-1948",
          vehicleNumber: "TS08UC4727",
        },
        md: "## Visible Text\nInvoice VS-1948\nVehicle TS08UC4727",
        sourceFileName: "packet.pdf",
      },
    ],
    {
      sourcePages: [
        {
          sourceFileName: "packet.pdf",
          pageNumber: 1,
          image: "data:image/png;base64,invoice",
        },
        {
          sourceFileName: "packet.pdf",
          pageNumber: 2,
          image: "data:image/png;base64,eway",
        },
      ],
      authoritativePacketReview: true,
      candidateMismatches: [
        {
          id: internalMismatchId,
          field: "vehicleNumber",
          values: [
            { docId: "invoice", value: "TS08UC4721" },
            { docId: "eway", value: "TS08UC4727" },
          ],
          analysis: "The printed vehicle numbers differ.",
        },
      ],
    },
  );

  assert.match(requestText, /"id":"mismatch-1"/);
  assert.doesNotMatch(requestText, new RegExp(internalMismatchId));
  assert.equal(result.authoritativeReview?.mismatches.length, 1);
  assert.equal(
    result.authoritativeReview?.mismatches[0].id,
    internalMismatchId,
  );
  assert.equal(
    result.authoritativeReview?.mismatches[0].field,
    "vehicleNumber",
  );
  assert.deepEqual(
    result.authoritativeReview?.mismatches[0].values.map((value) => ({
      docId: value.docId,
      isOutlier: value.isOutlier,
    })),
    [
      { docId: "invoice", isOutlier: false },
      { docId: "eway", isOutlier: true },
    ],
  );
});

test("authoritative review retries an undecided candidate and persists only a final decision", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });

  let calls = 0;
  mockGroundedReview(t, async () => {
    calls += 1;
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict: calls === 1 ? "needs_review" : "pass",
              corrections: [],
              reviewIssues: [],
              documentAudits: verifiedDocumentAudits(
                { docId: "invoice", supportedFields: ["vehicleNumber"] },
                { docId: "delivery", supportedFields: ["vehicleNumber"] },
              ),
              mismatchDecisions: [
                {
                  mismatchId: "mismatch-1",
                  status: calls === 1 ? "needs_review" : "dismissed",
                  primary: false,
                  outlierDocumentIds: [],
                  reason:
                    calls === 1
                      ? "The values need review."
                      : "The source pages show the same vehicle number with harmless spacing differences.",
                },
              ],
              termsChecklist: [],
              packetGroups: [
                {
                  label: "Eastern Steel / ESRM-1742",
                  documentIds: ["invoice", "delivery"],
                  relationship: "standard",
                  primaryDocumentIds: ["invoice"],
                  contextDocumentIds: [],
                  rationale: "Both pages belong to the same dispatch.",
                  caseSummary: {
                    counterpartyName: "Eastern Steel",
                    poNumber: "SIPL/PO/26-27/1048",
                    invoiceNumber: "ESRM/26-27/1742",
                    primaryReference: "ESRM/26-27/1742",
                    packetCategory: "Procurement packet",
                  },
                },
              ],
              pageQuality: [
                {
                  sourceFileName: "dispatch.pdf",
                  pageNumber: 1,
                  documentId: "invoice",
                  issues: [],
                  approvalSafe: true,
                  confidence: "high",
                  reason: "The page is clear and upright.",
                },
                {
                  sourceFileName: "dispatch.pdf",
                  pageNumber: 2,
                  documentId: "delivery",
                  issues: [],
                  approvalSafe: true,
                  confidence: "high",
                  reason: "The page is clear and upright.",
                },
              ],
              notes: [],
            }),
          },
        },
      ],
    });
  });

  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const result = await reviewAndCorrectExtractedDocuments(
    [
      {
        id: "invoice",
        type: "Tax Invoice",
        title: "Tax Invoice",
        pages: 1,
        fields: { vehicleNumber: "TS08UD6139" },
        md: "Vehicle No. TS08UD6139",
        sourceFileName: "dispatch.pdf",
      },
      {
        id: "delivery",
        type: "Delivery Note",
        title: "Delivery Note",
        pages: 1,
        fields: { vehicleNumber: "TS 08 UD 6139" },
        md: "Vehicle No. TS 08 UD 6139",
        sourceFileName: "dispatch.pdf",
      },
    ],
    {
      authoritativePacketReview: true,
      sourcePages: [
        {
          sourceFileName: "dispatch.pdf",
          pageNumber: 1,
          image: "data:image/png;base64,invoice",
        },
        {
          sourceFileName: "dispatch.pdf",
          pageNumber: 2,
          image: "data:image/png;base64,delivery",
        },
      ],
      candidateMismatches: [
        {
          id: "vehicle-formatting-candidate",
          field: "vehicleNumber",
          values: [
            { docId: "invoice", value: "TS08UD6139" },
            { docId: "delivery", value: "TS 08 UD 6139" },
          ],
        },
      ],
    },
  );

  assert.equal(calls, 2);
  assert.equal(result.authoritativeReview?.mismatches.length, 0);
  assert.equal(result.review.confirmedMismatchCount, 0);
  assert.equal(result.review.dismissedMismatchCount, 1);
  assert.equal(result.review.verdict, "pass");
});

test("authoritative review keeps quantity as the root issue and dismisses derivative tax noise", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });

  mockGroundedReview(t, async () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict: "needs_review",
              corrections: [],
              reviewIssues: [],
              documentAudits: verifiedDocumentAudits(
                {
                  docId: "invoice",
                  supportedFields: [
                    "invoiceNumber",
                    "referencePoNumber",
                    "itemQuantity",
                    "unit",
                    "taxRate",
                    "taxAmount",
                  ],
                },
                {
                  docId: "delivery",
                  supportedFields: [
                    "referenceInvoiceNumber",
                    "referencePoNumber",
                    "itemQuantity",
                    "unit",
                    "taxRate",
                    "taxAmount",
                  ],
                },
              ),
              mismatchDecisions: [
                {
                  mismatchId: "mismatch-1",
                  status: "confirmed",
                  primary: true,
                  outlierDocumentIds: ["delivery"],
                  reason:
                    "The delivery note prints 38.000 MT while the invoice prints 40.000 MT.",
                },
                {
                  mismatchId: "mismatch-2",
                  status: "dismissed",
                  primary: false,
                  outlierDocumentIds: [],
                  reason:
                    "The GST rate and arithmetic are correct; the amount difference is only a consequence of the quantity conflict.",
                },
              ],
              termsChecklist: [],
              packetGroups: [
                {
                  label: "Vardhan Steel / VS-2051",
                  documentIds: ["invoice", "delivery"],
                  relationship: "standard",
                  primaryDocumentIds: ["invoice"],
                  contextDocumentIds: [],
                  rationale: "Both pages refer to invoice VS-2051.",
                  caseSummary: {
                    counterpartyName: "Vardhan Steel",
                    poNumber: "SIPL/PO/26-27/0902",
                    invoiceNumber: "VS-2051",
                    primaryReference: "VS-2051",
                    packetCategory: "Procurement packet",
                  },
                },
              ],
              pageQuality: [
                {
                  sourceFileName: "packet.pdf",
                  pageNumber: 1,
                  documentId: "invoice",
                  issues: [],
                  approvalSafe: true,
                  confidence: "high",
                  reason: "The page is clear and upright.",
                },
                {
                  sourceFileName: "packet.pdf",
                  pageNumber: 2,
                  documentId: "delivery",
                  issues: [],
                  approvalSafe: true,
                  confidence: "high",
                  reason: "The page is clear and upright.",
                },
              ],
              notes: [],
            }),
          },
        },
      ],
    }),
  );

  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const documents: CaseDoc[] = [
    {
      id: "invoice",
      type: "Tax Invoice",
      title: "Tax Invoice",
      pages: 1,
      fields: {
        invoiceNumber: "VS-2051",
        referencePoNumber: "SIPL/PO/26-27/0902",
        itemQuantity: "40.000",
        unit: "MT",
        taxRate: "18",
        taxAmount: "360000",
      },
      md: "## Visible Text\nQuantity 40.000 MT\nIGST 18% 360000",
      sourceFileName: "packet.pdf",
    },
    {
      id: "delivery",
      type: "Delivery Note",
      title: "Delivery Note",
      pages: 1,
      fields: {
        referenceInvoiceNumber: "VS-2051",
        referencePoNumber: "SIPL/PO/26-27/0902",
        itemQuantity: "38.000",
        unit: "MT",
        taxRate: "18",
        taxAmount: "342000",
      },
      md: "## Visible Text\nQuantity 38.000 MT\nIGST 18% 342000",
      sourceFileName: "packet.pdf",
    },
  ];
  const result = await reviewAndCorrectExtractedDocuments(documents, {
    sourcePages: [
      {
        sourceFileName: "packet.pdf",
        pageNumber: 1,
        image: "data:image/png;base64,invoice",
      },
      {
        sourceFileName: "packet.pdf",
        pageNumber: 2,
        image: "data:image/png;base64,delivery",
      },
    ],
    authoritativePacketReview: true,
    candidateMismatches: [
      {
        id: "quantity-candidate",
        field: "itemQuantity",
        values: [
          { docId: "invoice", value: "40.000 MT" },
          { docId: "delivery", value: "38.000 MT" },
        ],
      },
      {
        id: "tax-candidate",
        field: "taxAmount",
        values: [
          { docId: "invoice", value: "360000" },
          { docId: "delivery", value: "342000" },
        ],
      },
    ],
  });

  assert.equal(result.authoritativeReview?.mismatches.length, 1);
  assert.equal(result.authoritativeReview?.mismatches[0].field, "itemQuantity");
  assert.equal(
    result.authoritativeReview?.mismatches[0].values.find(
      (value) => value.docId === "delivery",
    )?.isOutlier,
    true,
  );
});

test("authoritative review never persists a mismatch whose cited values are identical", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });

  let calls = 0;
  mockGroundedReview(t, async () => {
    calls += 1;
    const content =
      calls === 1
        ? {
            verdict: "needs_review",
            corrections: [],
            reviewIssues: [
              {
                field: "eWayBillNumber",
                evidence: [
                  { docId: "invoice", value: "181042763590" },
                  { docId: "eway", value: "181042763590" },
                ],
                reason: "The invoice and E-Way Bill numbers do not match.",
              },
            ],
            documentAudits: verifiedDocumentAudits(
              { docId: "invoice", supportedFields: ["eWayBillNumber"] },
              { docId: "eway", supportedFields: ["eWayBillNumber"] },
            ),
            mismatchDecisions: [],
            termsChecklist: [],
            packetGroups: [
              {
                label: "Aravali / AST/26-27/0521",
                documentIds: ["invoice", "eway"],
                relationship: "standard",
                primaryDocumentIds: ["invoice"],
                contextDocumentIds: [],
                rationale: "Both pages belong to the same transaction.",
                caseSummary: {
                  counterpartyName: "Aravali",
                  poNumber: "",
                  invoiceNumber: "AST/26-27/0521",
                  primaryReference: "AST/26-27/0521",
                  packetCategory: "Procurement packet",
                },
              },
            ],
            pageQuality: [
              {
                sourceFileName: "packet.pdf",
                pageNumber: 1,
                documentId: "invoice",
                issues: [],
                approvalSafe: true,
                confidence: "high",
                reason: "The page is clear and upright.",
              },
              {
                sourceFileName: "packet.pdf",
                pageNumber: 2,
                documentId: "eway",
                issues: [],
                approvalSafe: true,
                confidence: "high",
                reason: "The page is clear and upright.",
              },
            ],
            notes: [],
          }
        : {
            correctionDecisions: [],
            reviewIssueDecisions: [],
            pageQuality: [
              {
                sourceFileName: "packet.pdf",
                pageNumber: 1,
                documentId: "invoice",
                issues: [],
                approvalSafe: true,
                confidence: "high",
                reason: "The page is clear and upright.",
              },
              {
                sourceFileName: "packet.pdf",
                pageNumber: 2,
                documentId: "eway",
                issues: [],
                approvalSafe: true,
                confidence: "high",
                reason: "The page is clear and upright.",
              },
            ],
          };
    return Response.json({
      choices: [{ message: { content: JSON.stringify(content) } }],
    });
  });

  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const result = await reviewAndCorrectExtractedDocuments(
    [
      {
        id: "invoice",
        type: "Tax Invoice",
        title: "Tax Invoice",
        pages: 1,
        fields: { eWayBillNumber: "181042763590" },
        md: "## Visible Text\nE-Way Bill No 181042763590",
        sourceFileName: "packet.pdf",
      },
      {
        id: "eway",
        type: "E-Way Bill",
        title: "E-Way Bill",
        pages: 1,
        fields: { eWayBillNumber: "181042763590" },
        md: "## Visible Text\nE-Way Bill No 181042763590",
        sourceFileName: "packet.pdf",
      },
    ],
    {
      sourcePages: [
        {
          sourceFileName: "packet.pdf",
          pageNumber: 1,
          image: "data:image/png;base64,invoice",
        },
        {
          sourceFileName: "packet.pdf",
          pageNumber: 2,
          image: "data:image/png;base64,eway",
        },
      ],
      authoritativePacketReview: true,
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.reviewIssues.length, 0);
  assert.equal(result.review.reviewIssueCount, 0);
  assert.equal(result.review.proposedReviewIssueCount, 0);
});

test("authoritative review drops a source-backed but semantically equivalent issue", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });

  let calls = 0;
  mockGroundedReview(t, async () => {
    calls += 1;
    const content =
      calls === 1
        ? {
            verdict: "needs_review",
            corrections: [],
            reviewIssues: [
              {
                field: "invoiceNumber",
                evidence: [
                  { docId: "invoice", value: "INV-001" },
                  { docId: "eway", value: "INV001" },
                ],
                reason: "The invoice references conflict.",
              },
            ],
            documentAudits: verifiedDocumentAudits(
              { docId: "invoice", supportedFields: ["invoiceNumber"] },
              { docId: "eway", supportedFields: ["invoiceNumber"] },
            ),
            mismatchDecisions: [],
            termsChecklist: [],
            packetGroups: [
              {
                label: "Supplier / INV-001",
                documentIds: ["invoice", "eway"],
                relationship: "standard",
                primaryDocumentIds: ["invoice"],
                contextDocumentIds: [],
                rationale: "Both documents belong to one transaction.",
                caseSummary: {
                  counterpartyName: "Supplier",
                  poNumber: "",
                  invoiceNumber: "INV-001",
                  primaryReference: "INV-001",
                  packetCategory: "Procurement packet",
                },
              },
            ],
            pageQuality: [
              {
                sourceFileName: "packet.pdf",
                pageNumber: 1,
                documentId: "invoice",
                issues: [],
                approvalSafe: true,
                confidence: "high",
                reason: "The page is clear and upright.",
              },
              {
                sourceFileName: "packet.pdf",
                pageNumber: 2,
                documentId: "eway",
                issues: [],
                approvalSafe: true,
                confidence: "high",
                reason: "The page is clear and upright.",
              },
            ],
            notes: [],
          }
        : {
            correctionDecisions: [],
            reviewIssueDecisions: [
              {
                reviewIssueId: "evidence-review-1-invoiceNumber",
                verdict: "dismissed",
                reason:
                  "The two visible references identify the same invoice; the separator is only formatting.",
              },
            ],
            pageQuality: [
              {
                sourceFileName: "packet.pdf",
                pageNumber: 1,
                documentId: "invoice",
                issues: [],
                approvalSafe: true,
                confidence: "high",
                reason: "The page is clear and upright.",
              },
              {
                sourceFileName: "packet.pdf",
                pageNumber: 2,
                documentId: "eway",
                issues: [],
                approvalSafe: true,
                confidence: "high",
                reason: "The page is clear and upright.",
              },
            ],
          };
    return Response.json({
      choices: [{ message: { content: JSON.stringify(content) } }],
    });
  });

  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const result = await reviewAndCorrectExtractedDocuments(
    [
      {
        id: "invoice",
        type: "Tax Invoice",
        title: "Tax Invoice",
        pages: 1,
        fields: { invoiceNumber: "INV-001" },
        md: "## Visible Text\nInvoice No INV-001",
        sourceFileName: "packet.pdf",
      },
      {
        id: "eway",
        type: "E-Way Bill",
        title: "E-Way Bill",
        pages: 1,
        fields: { invoiceNumber: "INV001" },
        md: "## Visible Text\nInvoice No INV001",
        sourceFileName: "packet.pdf",
      },
    ],
    {
      sourcePages: [
        {
          sourceFileName: "packet.pdf",
          pageNumber: 1,
          image: "data:image/png;base64,invoice",
        },
        {
          sourceFileName: "packet.pdf",
          pageNumber: 2,
          image: "data:image/png;base64,eway",
        },
      ],
      authoritativePacketReview: true,
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.reviewIssues.length, 0);
  assert.equal(result.review.proposedReviewIssueCount, 0);
  assert.equal(result.review.dismissedReviewIssueCount, 0);
  assert.equal(result.review.verifiedReviewIssueCount, 0);
});

test("authoritative source audit keeps document tax without restoring unsupported line-item tax", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });

  mockGroundedReview(t, async () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict: "corrected",
              corrections: [
                {
                  docId: "invoice",
                  lineItems: [
                    {
                      lineNumber: "1",
                      description: "TMT BAR IS 1786 FE500D - 12 MM",
                      quantity: "24.000",
                      unit: "MT",
                    },
                  ],
                  evidence: {
                    sourceFileName: "packet.pdf",
                    pageNumber: 1,
                    quote: "QTY (MT) 24.000",
                  },
                  reason:
                    "The invoice prints IGST at document level but not on either item row.",
                },
              ],
              reviewIssues: [],
              documentAudits: [
                {
                  docId: "invoice",
                  status: "corrected",
                  supportedFields: ["invoiceNumber", "igstRate"],
                  unsupportedFields: [],
                  visibleOmittedFields: [],
                  supportedLineItemProperties: [
                    "lineNumber",
                    "description",
                    "quantity",
                    "unit",
                  ],
                  unsupportedLineItemProperties: ["taxRate", "igstRate"],
                  reason:
                    "The tax rate is printed only as a document total and is absent from each item row.",
                },
              ],
              mismatchDecisions: [],
              termsChecklist: [],
              packetGroups: [
                {
                  label: "Kaveri Alloy / INV-2574",
                  documentIds: ["invoice"],
                  relationship: "standard",
                  primaryDocumentIds: ["invoice"],
                  contextDocumentIds: [],
                  rationale: "The packet contains one tax invoice.",
                  caseSummary: {
                    counterpartyName: "Kaveri Alloy",
                    poNumber: "",
                    invoiceNumber: "INV-2574",
                    primaryReference: "INV-2574",
                    packetCategory: "Procurement packet",
                  },
                },
              ],
              pageQuality: [
                {
                  sourceFileName: "packet.pdf",
                  pageNumber: 1,
                  documentId: "invoice",
                  issues: [],
                  approvalSafe: true,
                  confidence: "high",
                  reason: "The page is clear and upright.",
                },
              ],
              notes: [],
            }),
          },
        },
      ],
    }),
  );

  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const result = await reviewAndCorrectExtractedDocuments(
    [
      {
        id: "invoice",
        type: "Tax Invoice",
        title: "Tax Invoice",
        pages: 1,
        fields: { invoiceNumber: "INV-2574", igstRate: "18" },
        lineItems: [
          {
            lineNumber: "1",
            description: "TMT BAR IS 1786 FE500D - 12 MM",
            quantity: "24.000",
            unit: "MT",
            taxRate: "18",
            igstRate: "18",
          },
        ],
        md: "## Visible Text\nTAX INVOICE INV-2574\nQTY (MT) 24.000\nIGST @ 18%",
        sourceFileName: "packet.pdf",
      },
    ],
    {
      sourcePages: [
        {
          sourceFileName: "packet.pdf",
          pageNumber: 1,
          image: "data:image/png;base64,delivery",
        },
      ],
      authoritativePacketReview: true,
    },
  );

  assert.equal(result.documents[0].fields.igstRate, "18");
  assert.equal(result.documents[0].lineItems?.[0].taxRate, undefined);
  assert.equal(result.documents[0].lineItems?.[0].igstRate, undefined);
  assert.equal(result.review.correctionCount, 1);
});
