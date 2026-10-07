import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaseDoc } from "../src/types/pipeline";
import {
  buildSourceAuditSchema,
  parseCompactSourceAudit,
  sourceAuditContext,
} from "../src/server/processing/staged-review-contract";
import {
  serializeFieldsWithLineItems,
  stripStoredLineItems,
} from "../src/server/line-items";
import { buildMatchInvoice } from "../src/server/sap/match-mapping";

const source: CaseDoc = {
  id: "invoice",
  type: "Tax Invoice",
  title: "Invoice",
  pages: 1,
  sourceFileName: "packet.pdf",
  sourcePageNumbers: [1],
  fields: { invoiceNumber: "INV-77", vendorName: "Aster Components" },
  md: "Invoice INV-77. Item ZX-8 Precision spacer 12 Nos 40.00 480.00",
};
const pages = [
  {
    sourceFileName: "packet.pdf",
    pageNumber: 1,
    image: "data:image/png;base64,fixture",
  },
];
const evidence = {
  pageNumber: "p1",
  quote: "ZX-8 Precision spacer 12 Nos 40.00 480.00",
};
function response(document = source) {
  const context = sourceAuditContext(document, pages);
  return {
    sourceVerdict: "verified",
    fieldChecks: Object.fromEntries(
      context.fieldChecksInOrder.map((key) => [key, "supported"]),
    ),
    lineItemChecks: Object.fromEntries(
      context.lineItemChecksInOrder.map((key) => [key, "supported"]),
    ),
    tableCoverage: { status: "complete", rows: [evidence], evidence },
    references: {
      invoiceNumber: {
        value: "INV-77",
        sourceLabel: "Invoice",
        valueKind: "reference",
        ...evidence,
        quote: "Invoice INV-77",
      },
    },
    newReferences: [],
    fieldChanges: [],
    removalEvidence: null,
    structureChange: null,
    pageQuality: [
      {
        pageNumber: "p1",
        issues: [],
        approvalSafe: true,
        confidence: "high",
        reason: "Legible source",
      },
    ],
    reviewIssues: [],
    reason: "Source inventory checked",
  };
}
const item = {
  itemCode: "ZX-8",
  description: "Precision spacer",
  quantity: "12",
  unit: "Nos",
  rate: "40.00",
  taxableAmount: "480.00",
  rawText: evidence.quote,
};
const parse = (payload: unknown, document = source) =>
  parseCompactSourceAudit(JSON.stringify(payload), document, pages);

test("empty first-pass items cannot pass when original source contains a row", () => {
  assert.throws(() => parse(response()), /extraction incomplete/);
  const payload = response();
  const { tableCoverage: ignored, ...withoutInventory } = payload;
  void ignored;
  assert.throws(() => parse(withoutInventory), /task contract/);
  assert.ok(
    buildSourceAuditSchema(source, pages).required.includes("tableCoverage"),
  );
});

test("recover a missing invoice table from its own evidence and preserve it through storage and SAP translation", () => {
  const result = parse({
    ...response(),
    structureChange: { lineItems: [item], evidence },
  });
  assert.equal(result.document.lineItems?.length, 1);
  assert.equal(result.document.lineItems?.[0].itemCode, "ZX-8");
  assert.equal(result.document.lineItems?.[0].quantity, "12");
  assert.equal(result.audit.tableCoverage?.status, "complete");
  const fields = serializeFieldsWithLineItems(result.document);
  assert.equal(
    Object.hasOwn(stripStoredLineItems(fields), "__tableCoverage"),
    false,
  );
  const invoice = buildMatchInvoice({
    caseInvoiceNumber: "INV-77",
    casePoNumber: null,
    documents: [{ document_type: "Tax Invoice", extracted_fields: fields }],
  });
  assert.equal(invoice?.extractionIssue, undefined);
  assert.equal(invoice?.lines.length, 1);
  assert.equal(invoice?.lines[0].quantity, 12);
});

test("partial tables and sanitization loss cannot masquerade as complete extraction", () => {
  const document = { ...source, lineItems: [item] };
  assert.throws(
    () =>
      parse(
        {
          ...response(document),
          tableCoverage: {
            status: "complete",
            rows: [evidence, evidence],
            evidence,
          },
        },
        document,
      ),
    /extraction incomplete/,
  );
  assert.throws(
    () =>
      parse({ ...response(), structureChange: { lineItems: [], evidence } }),
    /extraction incomplete/,
  );
  assert.throws(
    () =>
      parse(
        {
          ...response(document),
          tableCoverage: { status: "not_present", rows: [], evidence },
        },
        document,
      ),
    /no commercial rows/,
  );
});

test("coverage cannot cite another document's page or omit source evidence", () => {
  assert.throws(
    () =>
      parse({
        ...response(),
        tableCoverage: {
          status: "complete",
          rows: [{ ...evidence, pageNumber: "p2" }],
          evidence,
        },
      }),
    /own-page pointer/,
  );
  assert.throws(
    () =>
      parse({
        ...response(),
        tableCoverage: {
          status: "complete",
          rows: [evidence],
          evidence: { ...evidence, quote: "" },
        },
      }),
    /evidence quote/,
  );
});

test("unreadable tables require review and block SAP even if partial rows survived", () => {
  const document = { ...source, lineItems: [item] };
  const payload = {
    ...response(document),
    tableCoverage: { status: "unreadable", rows: [evidence], evidence },
  };
  assert.throws(() => parse(payload, document), /needs_review/);
  const result = parse({ ...payload, sourceVerdict: "needs_review" }, document);
  assert.equal(result.audit.status, "needs_review");
  const invoice = buildMatchInvoice({
    caseInvoiceNumber: "INV-77",
    casePoNumber: null,
    documents: [
      {
        document_type: "Tax Invoice",
        extracted_fields: serializeFieldsWithLineItems(result.document),
      },
    ],
  });
  assert.match(invoice?.extractionIssue ?? "", /incomplete or unverified/);
});

test("genuinely non-commercial documents are not forced to invent products", () => {
  const result = parse({
    ...response(),
    tableCoverage: {
      status: "not_present",
      rows: [],
      evidence: {
        pageNumber: "p1",
        quote: "Account statement without commercial goods rows",
      },
    },
  });
  assert.equal(result.document.lineItems?.length ?? 0, 0);
  assert.equal(result.audit.status, "verified");
});

test("saved completeness mismatches and deferred source verification block SAP, legacy rows remain usable", () => {
  for (const coverage of [
    { status: "unverified", rows: [] },
    { status: "complete", rows: [] },
  ]) {
    const fields = {
      ...serializeFieldsWithLineItems({ ...source, lineItems: [item] }),
      __tableCoverage: coverage,
    };
    const invoice = buildMatchInvoice({
      caseInvoiceNumber: "INV-77",
      casePoNumber: null,
      documents: [{ document_type: "Tax Invoice", extracted_fields: fields }],
    });
    assert.match(invoice?.extractionIssue ?? "", /incomplete or unverified/);
  }
  const invoice = buildMatchInvoice({
    caseInvoiceNumber: "INV-77",
    casePoNumber: null,
    documents: [
      {
        document_type: "Tax Invoice",
        extracted_fields: serializeFieldsWithLineItems({
          ...source,
          lineItems: [item],
        }),
      },
    ],
  });
  assert.equal(invoice?.extractionIssue, undefined);
});
