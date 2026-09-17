import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaseDoc } from "../src/types/pipeline";
import { readReferenceLedger } from "../src/server/processing/reference-ledger";
const document: CaseDoc = {
  id: "invoice",
  type: "Tax Invoice",
  title: "Commercial source",
  pages: 1,
  sourceFileName: "packet.pdf",
  sourcePageNumbers: [2],
  fields: {
    invoiceNumber: "TAX INVOICE/26/417",
    referenceInvoiceNumber: "TAX INVOICE",
  },
  md: "",
};
const proof = (
  value: string | null,
  sourceLabel: string,
  valueKind = "reference",
) => ({
  value,
  sourceLabel,
  valueKind,
  sourceFileName: "packet.pdf",
  pageNumber: 2,
  quote: `${sourceLabel}: ${value ?? "TAX INVOICE"}`,
});
test("reference values and evidence are materialized together, including new references", () => {
  const result = readReferenceLedger({
    document,
    sourcePages: [{ sourceFileName: "packet.pdf", pageNumber: 2 }],
    fields: {
      invoiceNumber: proof("TAX INVOICE/26/417", "Invoice No"),
      referenceInvoiceNumber: proof(null, "Document Type", "document_type"),
      vehicleNumber: proof("RJ14PX6110", "Vehicle"),
    },
  });
  assert.deepEqual(result.finalFields, {
    invoiceNumber: "TAX INVOICE/26/417",
    vehicleNumber: "RJ14PX6110",
  });
  assert.deepEqual(
    result.changes.map(({ field, value }) => ({ field, value })),
    [
      { field: "referenceInvoiceNumber", value: null },
      { field: "vehicleNumber", value: "RJ14PX6110" },
    ],
  );
  assert.deepEqual(
    result.proofs.map(({ field }) => field),
    ["invoiceNumber", "vehicleNumber"],
  );
});
test("a ledger cannot omit an original reference or add one without its paired own-page proof", () => {
  const run = (fields: unknown) =>
    readReferenceLedger({ document, fields, sourcePages: [] });
  assert.throws(
    () => run({ invoiceNumber: proof("TAX INVOICE/26/417", "Invoice No") }),
    /omitted original fields/,
  );
  assert.throws(
    () =>
      run({
        invoiceNumber: proof("TAX INVOICE/26/417", "Invoice No"),
        referenceInvoiceNumber: proof(null, "Document Type", "document_type"),
        vehicleNumber: { ...proof("RJ14PX6110", "Vehicle"), quote: "Vehicle:" },
      }),
    /Invalid semantic reference evidence/,
  );
});
test("explicitly unreadable reference evidence remains unresolved, not clean", () => {
  const result = readReferenceLedger({
    document: { ...document, fields: { invoiceNumber: "untrusted" } },
    fields: {
      invoiceNumber: { ...proof(null, "Invoice No", "unreadable"), quote: "" },
    },
    sourcePages: [],
  });
  assert.equal(result.hasUnresolvedSource, true);
  assert.deepEqual(result.finalFields, {});
});
