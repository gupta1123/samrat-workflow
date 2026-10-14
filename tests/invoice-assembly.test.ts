import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  parseInvoiceAssemblies,
  type InvoiceAssembly,
} from "../src/lib/invoice-assembly";
import { FIELD_DEFINITIONS } from "../src/server/document-schema";
import { serializeFieldsWithLineItems } from "../src/server/line-items";
import { buildMatchInvoice } from "../src/server/sap/match-mapping";
import { packetPointerAliases } from "../src/server/processing/staged-review";
import type { CaseDoc } from "../src/types/pipeline";
import { getInvoiceNumberApprovalBlockReason } from "../src/lib/invoice-approval";
import { buildDuplicateInvoiceIssues } from "../src/lib/duplicate-invoice";
import { buildDraftHeaderFields } from "../src/server/sap/draft-fields";

const fields = FIELD_DEFINITIONS.map((field) => field.key);
const header: CaseDoc = {
  id: "header",
  type: "Tax Invoice",
  title: "Commercial invoice",
  pages: 1,
  sourceFileName: "scan.pdf",
  sourcePageNumbers: [1],
  md: "Line Details are in Annexure",
  fields: {
    invoiceNumber: "CONS/17",
    vendorName: "Aster Rewards Limited",
    supplierGstin: "29ABCDE1234F1Z5",
    buyerGstin: "37ABCDE9999F1Z5",
    currency: "INR",
    documentDate: "20-08-2026",
    totalAmount: "2000000",
  },
  supplyNature: {
    kind: "services",
    evidence: [{ sourcePage: 1, quote: "Rewards programme" }],
  },
  tableCoverage: {
    status: "not_present",
    rows: [],
    evidence: {
      sourceFileName: "scan.pdf",
      pageNumber: 1,
      quote: "Line Details are in Annexure",
    },
  },
};
const annex: CaseDoc = {
  id: "annex",
  type: "Invoice",
  title: "Annexure",
  pages: 1,
  sourceFileName: "scan.pdf",
  sourcePageNumbers: [2],
  md: "Rewards benefit 1 EA 2000000",
  fields: {
    invoiceNumber: "CONS/17",
    vendorName: "Aster",
    documentDate: "20-08-2026",
    currency: "INR",
    totalAmount: "2000000",
  },
  lineItems: [
    {
      description: "Rewards benefit",
      quantity: "1",
      unit: "EA",
      rate: "2000000",
      lineTotal: "2000000",
      sourcePage: 2,
    },
  ],
  supplyNature: {
    kind: "services",
    evidence: [{ sourcePage: 2, quote: "Rewards benefit" }],
  },
  tableCoverage: {
    status: "complete",
    rows: [
      {
        sourceFileName: "scan.pdf",
        pageNumber: 2,
        quote: "Rewards benefit 1 EA 2000000",
      },
    ],
    evidence: {
      sourceFileName: "scan.pdf",
      pageNumber: 2,
      quote: "Description of Goods/Services",
    },
  },
};
const assembly = (): InvoiceAssembly => ({
  invoiceNumber: "CONS/17",
  fieldSources: Object.keys(header.fields).map((field) => ({
    field: field as keyof CaseDoc["fields"],
    docId: header.id,
  })),
  documents: [
    { docId: header.id, role: "header", duplicateOfDocId: null },
    { docId: annex.id, role: "billing", duplicateOfDocId: null },
  ],
  reason:
    "Cover and annexure explicitly identify the same invoice; the billing row is in the annexure.",
});
const saved = (docs: CaseDoc[]) =>
  docs.map((doc) => ({
    client_document_id: doc.id,
    document_type: doc.type,
    source_file_name: doc.sourceFileName,
    source_hint: `page ${doc.sourcePageNumbers?.join(", ")}`,
    extracted_fields: serializeFieldsWithLineItems(doc),
  }));
const match = (docs = [header, annex], plan: unknown = [assembly()]) =>
  buildMatchInvoice({
    caseInvoiceNumber: "CONS/17",
    casePoNumber: null,
    documents: saved(docs),
    invoiceAssemblies: plan,
  });

test("assemble a verified header and annexure without losing supplier GSTIN or billing source", () => {
  const invoice = match()!;
  assert.equal(invoice.extractionIssue, undefined);
  assert.equal(invoice.vendorName, "Aster Rewards Limited");
  assert.equal(invoice.vendorGstin, "29ABCDE1234F1Z5");
  assert.equal(invoice.invoiceDate, "2026-08-20");
  assert.equal(invoice.supplyNature, "services");
  assert.equal(invoice.lines.length, 1);
  assert.equal(invoice.lines[0].quantity, 1);
  assert.equal(invoice.lines[0].amount, 2000000);
  assert.equal(invoice.lines[0].source?.pageNumber, 2);
  assert.equal(invoice.lines[0].source?.documentId, "annex");
  assert.equal(
    invoice.fieldSources?.find((source) => source.field === "supplierGstin")
      ?.documentId,
    "header",
  );
  assert.deepEqual(match([annex, header]), invoice); // No document-order selection.
});

test("a missing assembly cannot fall back to whichever invoice page came first", () => {
  for (const docs of [
    [header, annex],
    [annex, header],
  ]) {
    const invoice = match(docs, [])!;
    assert.ok(invoice.extractionIssue);
    assert.equal(invoice.lines.length, 0);
  }
});

test("goods invoices preserve every continued billing table, including repeated products", () => {
  const goodsHeader = {
    ...header,
    supplyNature: {
      kind: "goods" as const,
      evidence: [{ sourcePage: 1, quote: "Steel" }],
    },
  };
  const goodsAnnex = {
    ...annex,
    supplyNature: {
      kind: "goods" as const,
      evidence: [{ sourcePage: 2, quote: "Steel" }],
    },
  };
  const continued = {
    ...goodsAnnex,
    id: "continued",
    sourcePageNumbers: [3],
    lineItems: [{ ...annex.lineItems![0], sourcePage: 3 }],
    tableCoverage: {
      ...annex.tableCoverage!,
      rows: [
        {
          sourceFileName: "scan.pdf",
          pageNumber: 3,
          quote: "Rewards benefit 1 EA 2000000",
        },
      ],
    },
  };
  const plan = assembly();
  plan.documents.push({
    docId: continued.id,
    role: "billing",
    duplicateOfDocId: null,
  });
  const invoice = match([goodsHeader, goodsAnnex, continued], [plan])!;
  assert.equal(invoice.extractionIssue, undefined);
  assert.equal(invoice.lines.length, 2);
  assert.deepEqual(
    invoice.lines.map((line) => line.source?.pageNumber),
    [2, 3],
  );
});

test("excluded copies require explicit duplicate decisions and identical billing observations", () => {
  const copy = {
    ...annex,
    id: "copy",
    lineItems: [{ ...annex.lineItems![0], sourcePage: 3 }],
  };
  const plan = assembly();
  plan.documents.push({
    docId: copy.id,
    role: "duplicate",
    duplicateOfDocId: "annex",
  });
  assert.equal(match([header, annex, copy], [plan])?.lines.length, 1);
  const changed = {
    ...copy,
    lineItems: [{ ...copy.lineItems[0], quantity: "2" }],
  };
  assert.ok(match([header, annex, changed], [plan])?.extractionIssue);
});

test("different invoices, conflicting GSTINs, missing pages and unverified tables stay blocked", () => {
  for (const altered of [
    { ...annex, fields: { ...annex.fields, invoiceNumber: "OTHER/1" } },
    { ...annex, fields: { ...annex.fields, supplierGstin: "29ZZZZZ1234F1Z5" } },
    {
      ...annex,
      tableCoverage: { ...annex.tableCoverage!, status: "unverified" as const },
    },
  ])
    assert.ok(match([header, altered])?.extractionIssue);
  assert.ok(match([header])?.extractionIssue);
  assert.throws(() =>
    parseInvoiceAssemblies(
      [assembly()],
      [header, annex],
      fields,
      new Set(["annex"]),
    ),
  );
});

test("a header role cannot hide a real billing table, and field sources cannot invent values", () => {
  const plan = assembly();
  plan.documents[1].role = "header";
  assert.throws(() => parseInvoiceAssemblies([plan], [header, annex], fields));
  const bad = assembly();
  bad.fieldSources.push({ field: "poNumber", docId: "header" });
  assert.throws(() => parseInvoiceAssemblies([bad], [header, annex], fields));
  const duplicate = assembly();
  duplicate.documents.push({ ...duplicate.documents[0] });
  assert.throws(() =>
    parseInvoiceAssemblies([duplicate], [header, annex], fields),
  );
});

test("invoice source pointers are lossless, including duplicate-copy references", () => {
  const aliases = packetPointerAliases([header, annex]);
  const plan = assembly();
  plan.documents[0] = {
    docId: "header",
    role: "duplicate",
    duplicateOfDocId: "annex",
  };
  assert.deepEqual(aliases.decode(aliases.encode([plan])), [plan]);
});

test("a declared unnumbered annexure is not a missing invoice number or a second invoice", () => {
  const docs = [
    header,
    { ...annex, fields: { ...annex.fields, invoiceNumber: "" } },
  ];
  const plan = assembly();
  assert.equal(match(docs, [plan])?.extractionIssue, undefined);
  const approvalDocs = docs.map((doc) => ({
    id: doc.id,
    documentType: doc.type,
    invoiceNumber: doc.fields.invoiceNumber,
    sourceFileName: doc.id + ".pdf",
  }));
  assert.equal(
    getInvoiceNumberApprovalBlockReason({
      invoiceNumber: "CONS/17",
      documents: approvalDocs,
      invoiceAssemblies: [plan],
    }),
    null,
  );
  assert.ok(
    getInvoiceNumberApprovalBlockReason({
      invoiceNumber: "CONS/17",
      documents: approvalDocs,
    }),
  );
  assert.deepEqual(
    buildDuplicateInvoiceIssues({
      documents: [
        approvalDocs[0],
        { ...approvalDocs[1], invoiceNumber: "CONS/17" },
      ],
      invoiceAssemblies: [plan],
    }),
    [],
  );
  const copiedPlan = structuredClone(plan);
  copiedPlan.documents[1].role = "duplicate";
  copiedPlan.documents[1].duplicateOfDocId = "header";
  assert.equal(
    buildDuplicateInvoiceIssues({
      documents: [
        approvalDocs[0],
        { ...approvalDocs[1], invoiceNumber: "CONS/17" },
      ],
      invoiceAssemblies: [copiedPlan],
    }).length,
    1,
  );
});

test("every numbered billing page must be present in the matching assembly", () => {
  const omitted = { ...annex, id: "omitted" };
  assert.ok(match([header, annex, omitted])?.extractionIssue);
});

test("posting uses a declared date source on an unnumbered continuation page", () => {
  const cover = {
    ...header,
    fields: { ...header.fields, documentDate: undefined },
  };
  const continued = {
    ...annex,
    fields: { ...annex.fields, invoiceNumber: "" },
  };
  const plan = assembly();
  plan.fieldSources = plan.fieldSources.map((source) =>
    source.field === "documentDate" ? { ...source, docId: "annex" } : source,
  );
  const invoice = match([cover, continued], [plan])!;
  const result = buildDraftHeaderFields({
    invoice,
    documents: saved([cover, continued]),
    metadata: [],
    service: true,
  });
  assert.equal(
    result.preview.fields.find((field) => field.key === "TaxDate")?.value,
    "2026-08-20",
  );
});

test("processing persists assemblies and the worker reads them without a database migration", () => {
  const root = new URL("../", import.meta.url);
  assert.ok(
    readFileSync(new URL("src/server/process-job.ts", root), "utf8").includes(
      "invoiceAssemblies:",
    ),
  );
  assert.ok(
    readFileSync(new URL("src/server/sap/match-job.ts", root), "utf8").includes(
      "status,processing_meta",
    ),
  );
});
