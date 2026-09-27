import assert from "node:assert/strict";
import test from "node:test";
import {
  assignExactOpenPoLines,
  sapDocumentNumber,
  selectUniqueExactOpenPurchaseOrder,
} from "../src/lib/sap-exact-po-match";

test("selects the one open PO with the exact document number and vendor", () => {
  const selected = selectUniqueExactOpenPurchaseOrder(
    [
      {
        DocEntry: 29798,
        DocNum: 100255,
        CardName: "TATA STEEL LIMITED(RETAIL)",
        DocumentStatus: "bost_Close",
        Cancelled: "tNO",
      },
      {
        DocEntry: 56604,
        DocNum: 100255,
        CardName: "TATA STEEL LIMITED(RETAIL)",
        DocumentStatus: "bost_Open",
        Cancelled: "tNO",
      },
      {
        DocEntry: 15529,
        DocNum: 100255,
        CardName: "TATA STEEL LIMITED (PROJECT)",
        DocumentStatus: "bost_Open",
        Cancelled: "tNO",
      },
    ],
    100255,
    "TATA STEEL LIMITED(RETAIL)",
  );

  assert.equal(selected?.DocEntry, 56604);
});

test("assigns a packet line only to the unique exact item, rate, and open quantity", () => {
  const assignments = assignExactOpenPoLines(
    [{ itemCode: "TTR027", quantity: "41.470", rate: "59807.00" }],
    [
      {
        ItemCode: "TTR027",
        RemainingOpenQuantity: 38.1,
        Price: 59807,
      },
      {
        ItemCode: "TTR027",
        RemainingOpenQuantity: 200,
        Price: 59807,
      },
    ],
  );

  assert.deepEqual(assignments, [1]);
});

test("rejects ambiguous or non-exact PO line assignments", () => {
  const packet = [{ itemCode: "TTR027", quantity: 41.47, rate: 59807 }];

  assert.equal(
    assignExactOpenPoLines(packet, [
      { ItemCode: "TTR027", RemainingOpenQuantity: 200, Price: 59807 },
      { ItemCode: "TTR027", RemainingOpenQuantity: 100, Price: 59807 },
    ]),
    null,
  );
  assert.equal(
    assignExactOpenPoLines(packet, [
      { ItemCode: "TTR027", RemainingOpenQuantity: 200, Price: 59808 },
    ]),
    null,
  );
  assert.equal(
    assignExactOpenPoLines(packet, [
      { ItemCode: "TTR027", RemainingOpenQuantity: 40, Price: 59807 },
    ]),
    null,
  );
});

test("parses only positive whole SAP document numbers", () => {
  assert.equal(sapDocumentNumber("100255"), 100255);
  assert.equal(sapDocumentNumber("100255.5"), null);
  assert.equal(sapDocumentNumber("PO-100255"), null);
});
