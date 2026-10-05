import assert from "node:assert/strict";
import { test } from "node:test";
import {
  selectedOrderEntries,
  supplierOrders,
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
