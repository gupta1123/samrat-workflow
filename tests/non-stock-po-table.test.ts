import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NonStockPoTable } from "@/components/cases/sap-match/NonStockPoTable";
import {
  fitsInvoiceLine,
  sharedWords,
} from "@/components/cases/sap-match/NonStockPoDrawer";

const { createElement } = React;
// The app compiles JSX with the automatic runtime; tsx here uses the classic one.
(globalThis as { React?: unknown }).React = React;

const cand = (lineNum: number, name: string, price: number) =>
  ({
    key: `PO:7:${lineNum}`,
    kind: "PO",
    docEntry: 7,
    docNum: 475,
    date: "2026-08-08",
    lineNum,
    documentType: "dDocument_Items",
    itemCode: "DM0001",
    itemName: "Others (PPA)",
    price,
    open: 350 * price,
    allocated: 0,
    rejected: null,
    good: [],
    bad: [],
    references: { po: ["475"] },
    poEvidence: {
      description: null,
      lineRemarks: name,
      headerRemarks: "PO of the RCPs",
      openQuantity: 350,
    },
  }) as never;
const pool = [
  cand(0, "Tiscon RCP - A4", 8.25),
  cand(1, "Tiscon RCP - A3", 13),
  cand(2, "CRS RCP - A4", 8.25),
  cand(3, "CRS RCP - A3", 13),
];
const line = (index: number, rate: number) =>
  ({
    index,
    kind: "unmapped",
    nonStockPoCandidates: pool,
    candidates: [],
    itemCode: null,
    itemName: null,
    invoiceQty: 350,
    invoiceRate: rate,
    invoiceAmount: 350 * rate,
    allocatedQty: 0,
    manual: false,
    po: null,
  }) as never;

test("four unresolved non-stock lines render as a summary table with a Choose PO line button per row", () => {
  const html = renderToStaticMarkup(
    createElement(NonStockPoTable, {
      caseId: "c",
      invoice: {
        poReferences: ["SIPL/475"],
        lines: [0, 1, 2, 3].map((index) => ({
          index,
          description: `Invoice line ${index + 1}`,
        })),
        source: { fileName: "inv.pdf", pageLabel: "page 1" },
      } as never,
      lines: [line(0, 8.25), line(1, 13), line(2, 8.25), line(3, 13)],
      checks: [],
      busy: false,
      locked: false,
      onChoose: () => {},
      onUndo: () => {},
      onAllocate: () => {},
      onResetAllocation: () => {},
      onLink: () => {},
    }),
  );
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.equal((html.match(/<table/g) ?? []).length, 1);
  assert.equal((html.match(/<tr/g) ?? []).length, 5);
  assert.match(text, /Choose the PO line for each invoice line/);
  assert.equal((text.match(/Choose PO line/g) ?? []).length, 4);
  assert.match(text, /cited on the invoice/);
  assert.doesNotMatch(html, /<select[^>]*PO line for invoice line/);
  assert.match(text, /PO 475 · 08 Aug 2026 · ₹14,875 left/);
  assert.match(text, /Invoice ₹14,875 · confirmed ₹0 · 4 of 4 lines left/);
  assert.ok(
    text.split(" ").length < 400,
    `too wordy: ${text.split(" ").length}`,
  );
});

test("drawer lists each PO line once and marks the words that tell lines apart", () => {
  const crs = line(2, 8.25) as never as Parameters<typeof fitsInvoiceLine>[0];
  const [a4, , c4] = pool as never as Parameters<typeof fitsInvoiceLine>[1][];
  assert.equal(fitsInvoiceLine(crs, a4), true);
  assert.equal(fitsInvoiceLine(crs, c4), true);
  assert.deepEqual(sharedWords("RCP - A4 - TG - 550SD", "Tiscon RCP - A4"), [
    "rcp",
  ]);
  assert.deepEqual(
    sharedWords("RCP - A4 - TG - CRS550D", "CRS RCP's - A4").sort(),
    ["crs550d", "rcp"],
  );
  const source = readFileSync(
    "src/components/cases/sap-match/NonStockPoDrawer.tsx",
    "utf8",
  );
  assert.match(source, /Which PO line is this\?/);
  assert.match(source, /onAllocate\(line\.index, \{ \[pick\]: amount \}\)/);
});
