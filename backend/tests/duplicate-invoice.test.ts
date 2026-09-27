import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCollapsedDuplicateInvoiceIssues,
  buildCrossCaseDuplicateInvoiceIssues,
  buildDuplicateInvoiceIssues,
  DUPLICATE_INVOICE_FIELD,
  normalizeInvoiceNumber,
} from "../src/lib/duplicate-invoice";

function doc(
  id: string,
  invoiceNumber: unknown,
  sourceFileName = "a.pdf",
  documentType = "Tax Invoice",
) {
  return { id, documentType, invoiceNumber, sourceFileName, title: documentType };
}

test("same invoice number in two different uploads raises a duplicate issue", () => {
  const issues = buildDuplicateInvoiceIssues({
    documents: [
      doc("doc-a", "INV-1001", "invoice.pdf"),
      doc("doc-b", "INV-1001", "invoice-copy.pdf"),
    ],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, DUPLICATE_INVOICE_FIELD);
  assert.ok(issues[0].id.startsWith("duplicate-invoice-number:"));
  assert.ok(String(issues[0].values[0].value).includes("INV-1001"));
  assert.ok(issues[0].analysis && issues[0].fixPlan);
});

test("number matching ignores case and surrounding whitespace", () => {
  const issues = buildDuplicateInvoiceIssues({
    documents: [
      doc("doc-a", " inv-1001 ", "a.pdf"),
      doc("doc-b", "INV-1001", "b.pdf"),
    ],
  });
  assert.equal(issues.length, 1);
  assert.equal(normalizeInvoiceNumber(" inv-1001 "), "INV-1001");
});

test("no issue for distinct numbers, blanks, or copies inside one file", () => {
  assert.deepEqual(
    buildDuplicateInvoiceIssues({
      documents: [doc("a", "INV-1", "a.pdf"), doc("b", "INV-2", "b.pdf")],
    }),
    [],
  );
  assert.deepEqual(
    buildDuplicateInvoiceIssues({
      documents: [doc("a", "", "a.pdf"), doc("b", null, "b.pdf")],
    }),
    [],
  );
  // Original + transporter copy pages of a single scan collapse elsewhere.
  assert.deepEqual(
    buildDuplicateInvoiceIssues({
      documents: [doc("a", "INV-1", "scan.pdf"), doc("b", "INV-1", "scan.pdf")],
    }),
    [],
  );
  // Non-invoice documents never count.
  assert.deepEqual(
    buildDuplicateInvoiceIssues({
      documents: [
        { ...doc("a", "X", "a.pdf"), documentType: "E-Way Bill" },
        { ...doc("b", "X", "b.pdf"), documentType: "E-Way Bill" },
      ],
    }),
    [],
  );
});

test("merged-away copies raise a collapse-trace issue naming every file", () => {
  const issues = buildCollapsedDuplicateInvoiceIssues({
    documents: [
      {
        id: "merged",
        documentType: "Tax Invoice",
        invoiceNumber: "INV-1001",
        collapsedDuplicateSources: ["a.pdf", "b.pdf", "a.pdf"],
      },
      { id: "solo", documentType: "Tax Invoice", invoiceNumber: "INV-2" },
      {
        id: "eway",
        documentType: "E-Way Bill",
        invoiceNumber: "X",
        collapsedDuplicateSources: ["a.pdf", "b.pdf"],
      },
    ],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, DUPLICATE_INVOICE_FIELD);
  assert.ok(String(issues[0].values[0].value).includes("a.pdf"));
  assert.ok(String(issues[0].values[0].value).includes("b.pdf"));
});

test("invoice already used in another live case raises a cross-case issue", () => {
  const issues = buildCrossCaseDuplicateInvoiceIssues({
    invoiceNumber: "INV-1001",
    currentCaseId: "case-now",
    siblings: [
      { id: "case-old", displayName: "Old case", status: "accepted", invoiceNumber: "INV-1001" },
      { id: "case-now", displayName: "This case", status: "processing", invoiceNumber: "INV-1001" },
      { id: "case-other", displayName: "Other", status: "completed", invoiceNumber: "INV-9999" },
    ],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, DUPLICATE_INVOICE_FIELD);
  assert.ok(String(issues[0].values[0].value).includes("Old case"));
  assert.ok(!String(issues[0].values[0].value).includes("Other"));
});

test("cross-case check stays silent without a usable number or match", () => {
  assert.deepEqual(
    buildCrossCaseDuplicateInvoiceIssues({
      invoiceNumber: "",
      currentCaseId: "case-now",
      siblings: [],
    }),
    [],
  );
  assert.deepEqual(
    buildCrossCaseDuplicateInvoiceIssues({
      invoiceNumber: "INV-1001",
      currentCaseId: "case-now",
      siblings: [
        { id: "s", displayName: "S", status: "completed", invoiceNumber: "INV-2" },
      ],
    }),
    [],
  );
});
