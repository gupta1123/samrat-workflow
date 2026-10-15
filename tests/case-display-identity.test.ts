import assert from "node:assert/strict";
import { test } from "node:test";
import { caseDisplayIdentity } from "../src/lib/case-display-identity";
import { mapCase } from "../src/server/api/helpers";
import { getInvoiceNumberApprovalBlockReason } from "../src/lib/invoice-approval";

const audit = (
  name = "Aster Metals",
  number = "INV-42",
  status = "verified",
) => ({
  status,
  fieldEvidence: [
    {
      field: "vendorName",
      value: name,
      evidence: { pageNumber: 1, quote: name },
    },
  ],
  referenceEvidence: [
    { field: "invoiceNumber", value: number, quote: `Invoice ${number}` },
  ],
});
const meta = (audits = [audit()]) => ({
  extractionReview: { documentAudits: audits },
  verificationGroups: [{ sourceFileNames: ["original.pdf"] }],
});

test("deferred reconciliation retains a proved display identity without treating it as approval", () => {
  const row = {
    id: "case",
    slug: "case",
    display_name: "Case",
    buyer_name: "",
    invoice_number: "",
    po_number: "",
    status: "completed",
    risk_score: 0,
    upload_count: 1,
    document_count: 1,
    mismatch_count: 1,
    created_at: "2026-10-15",
    deleted_at: null,
    processing_meta: meta(),
  };
  const mapped = mapCase(row);
  assert.equal(mapped.displayName, "Aster Metals / INV-42");
  assert.equal(mapped.displayInvoiceNumber, "INV-42");
  assert.equal(mapped.invoiceNumber, "");
  assert.equal(mapped.buyerName, "");
  assert.equal(row.display_name, "Case");
  assert.ok(
    getInvoiceNumberApprovalBlockReason({
      invoiceNumber: mapped.invoiceNumber,
      documents: [
        { id: "doc", documentType: "Tax Invoice", invoiceNumber: "INV-42" },
      ],
    }),
  );
});

test("unverified sources and conflicting supplier identities use the filename, not a guessed supplier", () => {
  const unverified = caseDisplayIdentity({
    displayName: "Case",
    processingMeta: meta([audit("Unsafe vendor", "INV-42", "needs_review")]),
  });
  assert.equal(unverified.displayName, "original.pdf");
  assert.equal(unverified.displayInvoiceNumber, null);
  const conflicting = caseDisplayIdentity({
    displayName: "Case",
    processingMeta: meta([audit(), audit("Another seller")]),
  });
  assert.equal(conflicting.displayName, "original.pdf / INV-42");
});

test("existing material case labels and repeated corroborating evidence remain unchanged", () => {
  assert.equal(
    caseDisplayIdentity({
      displayName: "Approved supplier / STEEL-17",
      processingMeta: meta(),
    }).displayName,
    "Approved supplier / STEEL-17",
  );
  assert.equal(
    caseDisplayIdentity({
      displayName: "Case",
      processingMeta: meta([audit(), audit()]),
    }).displayName,
    "Aster Metals / INV-42",
  );
  assert.equal(
    caseDisplayIdentity({
      displayName: "Case",
      processingMeta: meta([
        audit("Aster Metals", "INV-42"),
        audit("Aster Metals", "INV-43"),
      ]),
    }).displayInvoiceNumber,
    null,
  );
});
