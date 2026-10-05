import assert from "node:assert/strict";
import { test } from "node:test";
import {
  selectedOrderEntries,
  supplierOrders,
  supplierOrderMatchesInvoice,
  withSupplierInvoiceNumbers,
} from "../src/lib/sap-match/supplier-orders";
import { matchFixture } from "./sap-posted-fixture";

const line = {
  ...matchFixture.result.lines[0],
  candidates: [
    {
      ...matchFixture.result.lines[0].candidates[0],
      kind: "GRPO" as const,
      allocated: 40.15,
      purchaseOrder: { docEntry: 12, docNum: 100255, lineNum: 0 },
    },
  ],
};
const po = {
  DocEntry: 12,
  DocNum: 100255,
  CardCode: "TSPL001",
  DocumentStatus: "bost_Close",
  Cancelled: "tNO",
  DocumentLines: [
    {
      LineNum: 0,
      ItemCode: "TTR027",
      Quantity: 300,
      RemainingOpenQuantity: 0,
      Price: 59807,
    },
  ],
};

test("invoice filtering requires a full supplier invoice reference, preserving suffixes and separators", () => {
  const order = {
    ...supplierOrders([po], "TSPL001", [line], "service-layer")[0],
    invoiceNumbers: ["INV-123/1", "1138440572", "OTHER"],
  };
  assert.equal(supplierOrderMatchesInvoice(order, "1138440572"), true);
  assert.equal(supplierOrderMatchesInvoice(order, " inv-123/1 "), true);
  assert.equal(supplierOrderMatchesInvoice(order, "113844057"), false);
  assert.equal(supplierOrderMatchesInvoice(order, "INV-123"), false);
  assert.equal(supplierOrderMatchesInvoice(order, "INV1231"), false);
  assert.equal(supplierOrderMatchesInvoice(order, ""), false);
  assert.equal(
    supplierOrderMatchesInvoice({ ...order, invoiceNumbers: [] }, "1138440572"),
    false,
  );
});

test("the linked closed PO is marked by exact base entry, not printed number", () => {
  assert.deepEqual(selectedOrderEntries([line]), [12]);
  const orders = supplierOrders(
    [po, { ...po, DocEntry: 13 }],
    "TSPL001",
    [line],
    "service-layer",
  );
  assert.deepEqual(orders[0].selectedFor, [line.index]);
  assert.deepEqual(orders[1].selectedFor, []);
  assert.equal(orders[0].status, "Close");
  assert.equal(orders[0].lines[0].quantity, 300);
});
test("other suppliers, unidentified suppliers and cancelled documents stay outside the list", () => {
  const orders = supplierOrders(
    [
      po,
      { ...po, CardCode: "OTHER" },
      { ...po, CardCode: undefined },
      { ...po, Cancelled: "tYES" },
    ],
    "TSPL001",
    [line],
    "service-layer",
  );
  assert.equal(orders.length, 1);
});
test("the custom report retains its separate identity and groups repeated line rows", () => {
  const report = {
    DocEntry: 12,
    DocNum: 100255,
    "BP Code": "TSPL001",
    "PO Line Num": 0,
    ItemCode: "TTR027",
    Quantity: 300,
    OpenQty: 200,
    Price: 59807,
  };
  const orders = supplierOrders(
    [report, report, { ...report, "PO Line Num": 1, ItemCode: "TTR028" }],
    "TSPL001",
    [line],
    "spapi",
  );
  assert.equal(orders.length, 1);
  assert.equal(orders[0].lines.length, 2);
  assert.equal(orders[0].source, "Open PO report");
  assert.deepEqual(orders[0].selectedFor, []);
});
test("unallocated candidates are never described as selected", () => {
  assert.deepEqual(
    selectedOrderEntries([
      {
        ...line,
        candidates: line.candidates.map((candidate) => ({
          ...candidate,
          allocated: 0,
        })),
      },
    ]),
    [],
  );
});
test("PO rates use the matching engine's Price before UnitPrice", () => {
  const orders = supplierOrders(
    [{ ...po, DocumentLines: [{ ...po.DocumentLines[0], UnitPrice: 64000 }] }],
    "TSPL001",
    [line],
    "service-layer",
  );
  assert.equal(orders[0].lines[0].price, 59807);
});

test("supplier invoice references include closed GRPOs and deduplicate multiple linked invoices", () => {
  const orders = supplierOrders(
    [{ ...po, NumAtCard: "PO-REFERENCE" }],
    "TSPL001",
    [line],
    "service-layer",
  );
  const receipt = {
    CardCode: "TSPL001",
    Cancelled: "tNO",
    DocEntry: 100,
    DocumentStatus: "bost_Close",
    NumAtCard: "INV-1",
    U_TATAINV: "INV-1",
    DocumentLines: [{ LineNum: 0, BaseType: 22, BaseEntry: 12 }],
  };
  const result = withSupplierInvoiceNumbers(
    orders,
    "TSPL001",
    [
      receipt,
      { ...receipt, DocEntry: 101, NumAtCard: "INV-2", U_TATAINV: null },
      { ...receipt, CardCode: "OTHER", NumAtCard: "OTHER-INV" },
      { ...receipt, Cancelled: "tYES", NumAtCard: "CANCELLED" },
    ],
    [
      {
        CardCode: "TSPL001",
        Cancelled: "tNO",
        NumAtCard: "INV-1",
        DocumentLines: [{ BaseType: 20, BaseEntry: 100, BaseLine: 0 }],
      },
    ],
    "complete",
  );
  assert.deepEqual(result[0].invoiceNumbers, ["INV-1", "INV-2"]);
  assert.equal(result[0].invoiceLookup, "complete");
  assert.equal(result[0].reference, "PO-REFERENCE");
});

test("A/P invoice references follow the exact GRPO base line and direct PO links", () => {
  const orders = supplierOrders(
    [po, { ...po, DocEntry: 13, DocNum: 100256 }],
    "TSPL001",
    [line],
    "service-layer",
  );
  const receipt = {
    DocEntry: 100,
    CardCode: "TSPL001",
    Cancelled: "tNO",
    DocumentLines: [
      { LineNum: 0, BaseType: 22, BaseEntry: 12 },
      { LineNum: 1, BaseType: 22, BaseEntry: 13 },
    ],
  };
  const invoices = [
    {
      CardCode: "TSPL001",
      Cancelled: "tNO",
      NumAtCard: "AP-1",
      DocumentLines: [{ BaseType: 20, BaseEntry: 100, BaseLine: 1 }],
    },
    {
      CardCode: "TSPL001",
      Cancelled: "tNO",
      NumAtCard: "AP-2",
      DocumentLines: [{ BaseType: 22, BaseEntry: 12 }],
    },
    {
      CardCode: "TSPL001",
      Cancelled: "tNO",
      NumAtCard: "UNLINKED",
      DocumentLines: [{ BaseType: 20, BaseEntry: 100 }],
    },
  ];
  const result = withSupplierInvoiceNumbers(
    orders,
    "TSPL001",
    [receipt],
    invoices,
    "complete",
  );
  assert.deepEqual(result[0].invoiceNumbers, ["AP-2"]);
  assert.deepEqual(result[1].invoiceNumbers, ["AP-1"]);
});

test("report IDs are not joined to SL invoice IDs and partial reads stay explicit", () => {
  const orders = [
    ...supplierOrders([po], "TSPL001", [line], "service-layer"),
    ...supplierOrders([po], "TSPL001", [line], "spapi"),
  ];
  const result = withSupplierInvoiceNumbers(
    orders,
    "TSPL001",
    [],
    [],
    "partial",
  );
  assert.deepEqual(result[0].invoiceNumbers, []);
  assert.equal(result[0].invoiceLookup, "partial");
  assert.equal(result[1].invoiceLookup, "unavailable");
});

test("SAP crossjoin uses N/Y cancellation values; missing or cancelled values are excluded", () => {
  const orders = supplierOrders([po], "TSPL001", [line], "service-layer");
  const receipt = {
    CardCode: "TSPL001",
    Cancelled: "N",
    DocEntry: 99,
    NumAtCard: "INV-RAW",
    DocumentLines: [{ LineNum: 0, BaseType: 22, BaseEntry: 12 }],
  };
  const result = withSupplierInvoiceNumbers(
    orders,
    "TSPL001",
    [
      receipt,
      { ...receipt, Cancelled: "Y", NumAtCard: "CANCELLED" },
      { ...receipt, Cancelled: undefined, NumAtCard: "UNKNOWN" },
    ],
    [],
    "partial",
  );
  assert.deepEqual(result[0].invoiceNumbers, ["INV-RAW"]);
});
