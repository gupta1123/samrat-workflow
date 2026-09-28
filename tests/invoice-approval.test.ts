import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildInvoiceNumberRequiredIssues,
  consolidateInvoiceNumberIssues,
  getInvoiceNumberApprovalBlockReason,
  getPrimaryInvoiceDocuments,
  INVOICE_NUMBER_REQUIRED_FIELD,
} from "../src/lib/invoice-approval";

const invoice = {
  id: "invoice-1",
  documentType: "Tax Invoice",
  invoiceNumber: "INV-0532",
};

test("the same missing invoice requirement has one owner regardless of AI wording", () => {
  const required = buildInvoiceNumberRequiredIssues({
    invoiceNumber: "",
    documents: [{ ...invoice, invoiceNumber: "" }],
  });
  const ai = {
    id: "reviewer-note",
    field: "invoiceNumber",
    values: [{ docId: invoice.id, value: "INVOICE NUMBER" }],
    analysis: "Arbitrary phrasing; subject identity alone controls ownership.",
  };
  assert.deepEqual(
    consolidateInvoiceNumberIssues([ai, ...required], required),
    required,
  );
});

test("mandatory ownership does not suppress real reference conflicts or document-reading warnings", () => {
  const required = buildInvoiceNumberRequiredIssues({
    invoiceNumber: "",
    documents: [{ ...invoice, invoiceNumber: "" }],
  });
  const conflict = {
    id: "real-conflict",
    field: "invoiceNumber",
    values: [
      { docId: invoice.id, value: "" },
      { docId: "another-invoice", value: "INV-0541" },
    ],
    analysis: "Source conflict.",
  };
  const reading = {
    id: "reading",
    field: "extractionVerification",
    values: [{ docId: invoice.id, value: "Unresolved source" }],
    analysis: "Reading still requires review.",
  };
  assert.deepEqual(
    consolidateInvoiceNumberIssues([conflict, reading], required),
    [conflict, reading, ...required],
  );
  assert.deepEqual(consolidateInvoiceNumberIssues([conflict], []), [conflict]);
});

test("invoice number must be present on the actual invoice and the primary summary", () => {
  for (const invoiceNumber of [
    null,
    undefined,
    "",
    "  ",
    "\t\r\n",
    "\u00a0\ufeff",
    {},
    true,
  ]) {
    assert.ok(
      getInvoiceNumberApprovalBlockReason({
        invoiceNumber: "PO-123",
        documents: [{ ...invoice, invoiceNumber }],
      }),
    );
    assert.equal(
      buildInvoiceNumberRequiredIssues({
        invoiceNumber: "PO-123",
        documents: [{ ...invoice, invoiceNumber }],
      }).length,
      1,
    );
  }
  assert.ok(
    getInvoiceNumberApprovalBlockReason({
      invoiceNumber: " ",
      documents: [invoice],
    }),
  );
  assert.equal(
    getInvoiceNumberApprovalBlockReason({
      invoiceNumber: "INV-0532",
      documents: [invoice],
    }),
    null,
  );
  assert.deepEqual(
    buildInvoiceNumberRequiredIssues({
      invoiceNumber: "INV-0532",
      documents: [invoice],
    }),
    [],
  );
});

test("transport references and a numbered sibling invoice cannot replace a blank primary invoice", () => {
  const documents = [
    invoice,
    { id: "invoice-2", documentType: "Invoice", invoiceNumber: "" },
    { id: "eway", documentType: "E-Way Bill", invoiceNumber: "INV-0533" },
  ];
  const issues = buildInvoiceNumberRequiredIssues({
    invoiceNumber: "INV-0532",
    documents,
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, INVOICE_NUMBER_REQUIRED_FIELD);
  assert.equal(issues[0].values[0].docId, "invoice-2");
  assert.ok(
    getInvoiceNumberApprovalBlockReason({
      invoiceNumber: "INV-0533",
      documents: [documents[2]],
    }),
  );
});

test("reviewer-selected mother-bill context is excluded, buyer-facing invoices remain mandatory", () => {
  const documents = [
    invoice,
    { id: "upstream", documentType: "Invoice", invoiceNumber: "" },
  ];
  const verificationGroups = [
    {
      roleSelection: {
        strategy: "seller_chain",
        primaryDocumentIds: [invoice.id],
        contextDocumentIds: ["upstream"],
      },
    },
  ];
  assert.deepEqual(getPrimaryInvoiceDocuments(documents, verificationGroups), [
    invoice,
  ]);
  assert.equal(
    getInvoiceNumberApprovalBlockReason({
      invoiceNumber: "INV-0532",
      documents,
      verificationGroups,
    }),
    null,
  );
  assert.ok(
    getInvoiceNumberApprovalBlockReason({
      invoiceNumber: "INV-0532",
      documents: [{ ...invoice, invoiceNumber: "" }, documents[1]],
      verificationGroups,
    }),
  );
});
