import assert from "node:assert/strict";
import { test } from "node:test";

import { selectOpenGrposBasedOnPurchaseOrders } from "../src/lib/sap-grpo-relations";

test("selects a GRPO through SAP's PO DocEntry relationship", () => {
  const purchaseOrders = [
    { DocEntry: 56620, CardCode: "TSPL001" },
    { DocEntry: 100, CardCode: "OTHER" },
  ];
  const grpos = [
    {
      DocEntry: 169041,
      DocumentStatus: "bost_Open",
      Cancelled: "tNO",
      CardCode: "TSPL001",
      DocumentLines: [
        {
          BaseType: 22,
          BaseEntry: 56620,
          LineStatus: "bost_Open",
          RemainingOpenQuantity: 30.31,
        },
      ],
    },
    {
      DocEntry: 200000,
      DocumentStatus: "bost_Open",
      Cancelled: "tNO",
      CardCode: "TSPL001",
      DocumentLines: [
        {
          BaseType: 22,
          BaseEntry: 99999,
          LineStatus: "bost_Open",
          RemainingOpenQuantity: 30.31,
        },
      ],
    },
  ];

  assert.deepEqual(
    selectOpenGrposBasedOnPurchaseOrders(grpos, purchaseOrders).map(
      (document) => document.DocEntry,
    ),
    [169041],
  );
});

test("rejects closed, cancelled, exhausted, non-PO, and wrong-vendor receipts", () => {
  const base = {
    DocumentStatus: "bost_Open",
    Cancelled: "tNO",
    CardCode: "TSPL001",
    DocumentLines: [
      {
        BaseType: 22,
        BaseEntry: 56620,
        LineStatus: "bost_Open",
        RemainingOpenQuantity: 1,
      },
    ],
  };
  const grpos = [
    { ...base, DocEntry: 1, DocumentStatus: "bost_Close" },
    { ...base, DocEntry: 2, Cancelled: "tYES" },
    { ...base, DocEntry: 3, CardCode: "OTHER" },
    {
      ...base,
      DocEntry: 4,
      DocumentLines: [{ ...base.DocumentLines[0], BaseType: 20 }],
    },
    {
      ...base,
      DocEntry: 5,
      DocumentLines: [{ ...base.DocumentLines[0], RemainingOpenQuantity: 0 }],
    },
  ];

  assert.deepEqual(
    selectOpenGrposBasedOnPurchaseOrders(grpos, [
      { DocEntry: 56620, CardCode: "TSPL001" },
    ]),
    [],
  );
});
