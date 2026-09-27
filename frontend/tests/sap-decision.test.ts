import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifySapCase,
  matchSapReference,
  normalizeSapReference,
  parseSapAmount,
  rankSapCandidates,
  scoreVendorNames,
} from "../src/lib/sap-decision";

function doc(type: string, fields: Record<string, unknown> = {}) {
  return { id: type, documentType: type, extractedFields: fields };
}

test("GRN + AP plan when packet has PO, receipt evidence, and vendor invoice", () => {
  const result = classifySapCase({
    casePoNumber: "PO-101",
    caseInvoiceNumber: "INV-77",
    documents: [
      doc("Purchase Order", { poNumber: "PO-101" }),
      doc("Weighment Slip"),
      doc("Tax Invoice", { invoiceNumber: "INV-77" }),
    ],
  });
  assert.deepEqual(result.plan, ["GRN", "AP"]);
  assert.equal(result.blockedReason, null);
});

test("GRN-only plan when packet has PO and receipt evidence but no invoice", () => {
  const result = classifySapCase({
    casePoNumber: "PO-101",
    caseInvoiceNumber: null,
    documents: [doc("Purchase Order", { poNumber: "PO-101" }), doc("Lorry Receipt")],
  });
  assert.deepEqual(result.plan, ["GRN"]);
});

test("AP-only plan when packet has a numbered vendor invoice but no receipt evidence", () => {
  const result = classifySapCase({
    casePoNumber: null,
    caseInvoiceNumber: "INV-77",
    documents: [doc("Tax Invoice", { invoiceNumber: "INV-77" })],
  });
  assert.deepEqual(result.plan, ["AP"]);
});

test("blocked when nothing usable was extracted", () => {
  const result = classifySapCase({
    casePoNumber: null,
    caseInvoiceNumber: null,
    documents: [doc("Tax Invoice", { invoiceNumber: "" })],
  });
  assert.deepEqual(result.plan, []);
  assert.ok(result.blockedReason);
});

test("reference matching ignores case, spaces, dashes, and slashes", () => {
  assert.equal(normalizeSapReference(" ARM/26-27/101 "), "ARM2627101");
  assert.equal(matchSapReference("ARM/26-27/101", [15, "arm-26-27-101"]), "arm-26-27-101");
  assert.equal(matchSapReference("", [15]), null);
  assert.equal(matchSapReference("PO-1", [2, 3]), null);
});

test("vendor scoring ignores legal suffixes and matches across SAP naming", () => {
  assert.equal(scoreVendorNames("Schnell India Machinery Pvt Ltd", "SCHNELL INDIA MACHINERY PVT LTD"), 1);
  assert.ok(scoreVendorNames("Tata Steel Limited", "TATA STEEL LIMITED(RETAIL)") >= 1);
  assert.ok(scoreVendorNames("Sahyadri Steel Products Private Limited", "TATA STEEL LIMITED(RETAIL)") < 0.5);
  assert.equal(scoreVendorNames("", "TATA STEEL"), 0);
});

test("candidate ranking prefers same vendor with close totals", () => {
  const ranked = rankSapCandidates({
    caseVendor: "Schnell India Machinery Pvt Ltd",
    caseTotal: 3759.01,
    rows: [
      { docNum: 15, vendorName: "SCHNELL INDIA MACHINERY PVT LTD", totalAmount: 3759.008 },
      { docNum: 99, vendorName: "TATA STEEL LIMITED(RETAIL)", totalAmount: 3759.0 },
      { docNum: 100, vendorName: "SCHNELL INDIA MACHINERY PVT LTD", totalAmount: 999999 },
    ],
  });
  assert.equal(ranked[0].docNum, "15");
  assert.ok(ranked[0].reasons.includes("same vendor"));
  assert.ok(ranked[0].reasons.includes("total matches"));
  assert.ok(!ranked.some((c) => c.docNum === "99" && c.reasons.includes("same vendor")));
});

test("amount parsing tolerates formatted strings", () => {
  assert.equal(parseSapAmount("1,940,353.00"), 1940353);
  assert.equal(parseSapAmount(42.5), 42.5);
  assert.equal(parseSapAmount(null), null);
});
