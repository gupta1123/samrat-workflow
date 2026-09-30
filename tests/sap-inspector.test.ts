import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSapInspectorRecord } from "../src/lib/sap-inspector";

test("OpenPO rows expose the exact SAP identifiers used during matching", () => {
  const row = normalizeSapInspectorRecord(
    "open-po",
    {
      DocEntry: 41,
      DocNum: 1204,
      "BP Code": "V100",
      "BP Name": "Tata Steel",
      "PO Line Num": 2,
      ItemCode: "STEEL-01",
      Dscription: "TMT steel",
      Quantity: 10,
      OpenQty: 4,
      Price: 500,
    },
    0,
  );

  assert.equal(row.status, "Open");
  assert.equal(row.docEntry, "41");
  assert.equal(row.docNumber, "1204");
  assert.equal(row.vendorCode, "V100");
  assert.equal(row.lines[0].itemCode, "STEEL-01");
  assert.equal(row.lines[0].openQuantity, 4);
  assert.equal(
    row.findings.some((finding) => finding.severity === "blocked"),
    false,
  );
});

test("GRPO diagnostics explain missing PO relationships and exhausted quantity", () => {
  const row = normalizeSapInspectorRecord(
    "grpo",
    {
      DocEntry: 90,
      DocNum: 770,
      CardCode: "V100",
      CardName: "Tata Steel",
      DocumentStatus: "bost_Open",
      Cancelled: "tNO",
      DocumentLines: [
        {
          LineNum: 0,
          ItemCode: "STEEL-01",
          Quantity: 10,
          RemainingOpenQuantity: 0,
        },
      ],
    },
    0,
  );

  const titles = row.findings.map((finding) => finding.title);
  assert.ok(titles.includes("No Purchase Order base link"));
  assert.ok(titles.includes("GRPO is fully invoiced"));
  assert.ok(titles.includes("Vendor invoice reference is blank"));
});

test("OpenGRPO feed gaps are explained without treating omitted fields as bad SAP data", () => {
  const row = normalizeSapInspectorRecord(
    "grpo",
    {
      DocNum: 770,
      "Posting Date": "2026-09-30T00:00:00",
      "BP Code": "V100",
      "BP Name": "Tata Steel",
      ItemCode: "STEEL-01",
      Quantity: 10,
      OpenQty: 4,
    },
    0,
    { feed: "spapi" },
  );

  assert.equal(row.status, "Open");
  assert.equal(row.date, "2026-09-30T00:00:00");
  assert.ok(
    row.findings.some(
      (finding) => finding.title === "DocEntry is not exposed by this feed",
    ),
  );
  assert.ok(
    row.findings.some(
      (finding) => finding.title === "PO base link is not exposed by this feed",
    ),
  );
  assert.equal(
    row.findings.some((finding) => finding.severity === "blocked"),
    false,
  );
});

test("AP invoice diagnostics require NumAtCard for exact duplicate matching", () => {
  const row = normalizeSapInspectorRecord(
    "ap-invoice",
    {
      DocEntry: 201,
      DocNum: 301,
      CardCode: "V100",
      DocumentStatus: "bost_Open",
      Cancelled: "tNO",
      DocumentLines: [
        {
          LineNum: 0,
          ItemCode: "STEEL-01",
          Quantity: 2,
          BaseType: 20,
          BaseEntry: 90,
          BaseLine: 0,
        },
      ],
    },
    0,
  );

  assert.ok(
    row.findings.some(
      (finding) =>
        finding.severity === "blocked" &&
        finding.title === "Vendor invoice number is blank",
    ),
  );
});
