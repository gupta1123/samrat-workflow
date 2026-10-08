import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveReceiptSupplier } from "../src/server/sap/receipt-supplier";

const invoice = {
  invoiceNumber: "INV-701",
  eWayBill: "187001234567",
  vendorGstin: null,
};
const config = { invoiceRefField: "U_SUPINV", eWayBillField: "U_EWAY" };
const supplier = {
  CardCode: "SUP-7",
  CardName: "Example Metals - Retail",
  BPAddresses: [{ GSTIN: "20ABCDE1234F1Z1" }],
};
const receipt = {
  DocEntry: 81,
  DocNum: 901,
  CardCode: "SUP-7",
  DocumentStatus: "bost_Open",
  Cancelled: "tNO",
  NumAtCard: "INV-701-A",
  U_EWAY: "187001234567",
  DocumentLines: [{ LineStatus: "bost_Open", RemainingOpenQuantity: 30 }],
};

test("uses an exact e-way bill to identify the actual receipt BP without a GSTIN or name guess", () => {
  const result = resolveReceiptSupplier(invoice, [receipt], [supplier], config);
  assert.equal(result.vendor?.cardCode, "SUP-7");
  assert.equal(result.identification?.method, "receipt-reference");
  assert.deepEqual(
    result.identification?.receiptEvidence?.map((e) => [
      e.docNum,
      e.field,
      e.value,
    ]),
    [[901, "E-Way Bill No.", "187001234567"]],
  );
});

test("keeps evidence from multiple receipts under the same BP", () => {
  const result = resolveReceiptSupplier(
    invoice,
    [receipt, { ...receipt, DocEntry: 82, DocNum: 902 }],
    [supplier],
    config,
  );
  assert.equal(result.vendor?.cardCode, "SUP-7");
  assert.equal(result.identification?.receiptEvidence?.length, 2);
});

test("accepts exact standard or configured invoice references without an e-way bill", () => {
  for (const fields of [
    { NumAtCard: "INV-701" },
    { NumAtCard: null, U_SUPINV: "INV-701" },
  ]) {
    const result = resolveReceiptSupplier(
      { ...invoice, eWayBill: null },
      [{ ...receipt, ...fields }],
      [supplier],
      config,
    );
    assert.equal(result.vendor?.cardCode, "SUP-7");
  }
});

test("does not interpret invoice suffixes or use a similar name, quantity, vehicle or LR", () => {
  const result = resolveReceiptSupplier(
    { ...invoice, eWayBill: null },
    [receipt],
    [supplier],
    config,
  );
  assert.equal(result.vendor, null);
  assert.deepEqual(result.ambiguous, []);
});

test("conflicting exact references across suppliers require confirmation", () => {
  const other = { CardCode: "SUP-8", CardName: "Other Metals" };
  const result = resolveReceiptSupplier(
    invoice,
    [
      receipt,
      {
        ...receipt,
        DocEntry: 82,
        CardCode: "SUP-8",
        U_EWAY: null,
        NumAtCard: "INV-701",
      },
    ],
    [supplier, other],
    config,
  );
  assert.equal(result.vendor, null);
  assert.equal(result.ambiguous.length, 2);
});

test("a missing BP lookup cannot turn an ambiguous set into a unique match", () => {
  const result = resolveReceiptSupplier(
    invoice,
    [receipt, { ...receipt, DocEntry: 82, CardCode: "SUP-8" }],
    [supplier],
    config,
  );
  assert.equal(result.vendor, null);
});

test("an extracted GSTIN must agree with the receipt supplier", () => {
  assert.equal(
    resolveReceiptSupplier(
      { ...invoice, vendorGstin: "DIFFERENT" },
      [receipt],
      [supplier],
      config,
    ).vendor,
    null,
  );
  assert.equal(
    resolveReceiptSupplier(
      { ...invoice, vendorGstin: "20ABCDE1234F1Z1" },
      [receipt],
      [supplier],
      config,
    ).vendor?.cardCode,
    "SUP-7",
  );
});

test("closed, cancelled, exhausted or unverifiable receipts cannot identify a supplier", () => {
  for (const invalid of [
    { ...receipt, DocumentStatus: "bost_Close" },
    { ...receipt, Cancelled: "tYES" },
    { ...receipt, DocNum: undefined },
    {
      ...receipt,
      DocumentLines: [{ LineStatus: "bost_Open", RemainingOpenQuantity: 0 }],
    },
    {
      ...receipt,
      DocumentLines: [{ LineStatus: "bost_Close", RemainingOpenQuantity: 30 }],
    },
  ])
    assert.equal(
      resolveReceiptSupplier(invoice, [invalid], [supplier], config).vendor,
      null,
    );
});

test("blank and zero e-way references do not identify a supplier", () => {
  for (const value of [null, "", "0"])
    assert.equal(
      resolveReceiptSupplier(
        { ...invoice, eWayBill: value },
        [{ ...receipt, U_EWAY: value }],
        [supplier],
        config,
      ).vendor,
      null,
    );
});
