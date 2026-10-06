import assert from "node:assert/strict";
import { test } from "node:test";

import { combineExactReceiptMatches } from "../src/server/sap/service-layer";

const document = (DocEntry: number, DocNum = DocEntry) => ({
  DocEntry,
  DocNum,
  CardCode: "V-SUPPLIER",
});

test("all exact GRPO searches are combined for one invoice and overlaps are de-duplicated", () => {
  const combined = combineExactReceiptMatches([
    {
      identifier: { field: "Invoice No.", value: "INV-2041" },
      documents: [document(101), document(102)],
    },
    {
      identifier: { field: "Vehicle No.", value: "AP39TR2041" },
      documents: [document(102), document(103)],
    },
    {
      identifier: { field: "E-Way Bill No.", value: "181000020041" },
      documents: [],
    },
  ]);

  assert.deepEqual(
    combined.documents.map((entry) => entry.DocEntry),
    [101, 102, 103],
  );
  assert.deepEqual(combined.identifiers, [
    { field: "Invoice No.", value: "INV-2041" },
    { field: "Vehicle No.", value: "AP39TR2041" },
  ]);
});

test("combined GRPO search keeps deterministic strength order and enforces its bound", () => {
  const combined = combineExactReceiptMatches(
    [
      {
        identifier: { field: "Invoice No.", value: "INV-2042" },
        documents: [document(201), document(202)],
      },
      {
        identifier: { field: "Vehicle No.", value: "AP39TR2042" },
        documents: [document(203)],
      },
    ],
    2,
  );

  assert.deepEqual(
    combined.documents.map((entry) => entry.DocEntry),
    [201, 202],
  );
  assert.deepEqual(combined.identifiers, [
    { field: "Invoice No.", value: "INV-2042" },
  ]);
});
