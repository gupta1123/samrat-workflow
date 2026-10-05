import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sapDocumentSnapshot,
  assertSapPostingIdentity,
} from "../src/lib/sap-posting-preview";
import { postedSapDetails } from "../src/lib/sap-posted-details";
import { postedFixture } from "./sap-posted-fixture";
import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const document = {
  DocEntry: 237631,
  DocNum: 850,
  CardCode: "TSPL001",
  CardName: "Tata Steel",
  NumAtCard: "1138440577",
  DocObjectCode: "oPurchaseInvoices",
  DocCurrency: "INR",
  DocTotal: 2923705,
  VatSum: 446435.33,
  RoundingDiffAmount: 0.38,
  U_TATAINV: "1138440577",
  U_TATAINVDT: "2026-06-19",
  U_TRSPRT: "JAYABHERI LOGISTICS",
  U_MTRFORM: "ST",
  U_TATKTW: null,
  U_SAMKTW: "41.47",
  U_TOTQTY: "41.47",
  DocumentLines: [
    {
      ItemCode: "TTR027",
      Quantity: 41.47,
      UnitPrice: 59807,
      LineTotal: 2480196.29,
      BaseType: 20,
      BaseEntry: 169052,
      BaseLine: 0,
      InternalNote: "exclude",
    },
  ],
  WithholdingTaxDataCollection: [{ WTCode: "194Q", WTAmount: 2927 }],
  InternalOnly: "exclude",
};

test("SAP preview rejects another case's document and another draft object type", () => {
  const expected = {
    entry: 237631,
    vendor: "TSPL001",
    invoice: "1138440577",
    draft: true,
  };
  assert.doesNotThrow(() => assertSapPostingIdentity(document, expected));
  for (const mutation of [
    { DocEntry: 237632 },
    { CardCode: "OTHER" },
    { NumAtCard: "OTHER" },
    { DocObjectCode: "oOrders" },
  ])
    assert.throws(() =>
      assertSapPostingIdentity({ ...document, ...mutation }, expected),
    );
});

test("snapshots retain submitted header fields and explicit SAP amounts without internals", () => {
  const snapshot = sapDocumentSnapshot(document);
  assert.equal(snapshot.document.U_TATKTW, null);
  assert.equal(snapshot.document.DocTotal, 2923705);
  assert.equal(snapshot.document.InternalOnly, undefined);
  assert.equal(
    (snapshot.document.DocumentLines as Record<string, unknown>[])[0]
      .InternalNote,
    undefined,
  );
});

test("saved draft evidence keeps selections and explicitly blank weights", () => {
  const details = postedSapDetails({
    ...postedFixture,
    payload: {
      ...postedFixture.payload,
      draftHeaderFields: { U_TRSPRT: "JAYABHERI LOGISTICS", U_TATKTW: null },
      draftHeaderEvidence: [
        {
          key: "U_TRSPRT",
          label: "Transporter",
          value: "JAYABHERI LOGISTICS",
          source: "Selected for this draft",
        },
        {
          key: "U_TATKTW",
          label: "Supplier Kata weight (MT)",
          value: 41.47,
          source: "Not recorded in PDF",
        },
      ],
    },
  });
  assert.equal(details.headerFields?.[0].source, "Selected for this draft");
  assert.equal(details.headerFields?.[1].value, null);
});

const output = resolve("tmp/posting-preview-ui-test.cjs");
buildSync({
  entryPoints: ["src/components/cases/sap-match/SavedPostingPreview.tsx"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  external: ["react", "react-dom", "next"],
});
const { SavedPostingPreview } = createRequire(resolve("package.json"))(output);

test("saved preview shows actual tax and withholding, preserves missing weights, and offers no SAP write action", () => {
  const details = postedSapDetails({
    ...postedFixture,
    response: {
      ...postedFixture.response,
      SapDocumentSnapshot: sapDocumentSnapshot(document),
    },
  });
  const html = renderToStaticMarkup(
    createElement(SavedPostingPreview, { caseId: "case-id", details }),
  );
  for (const text of [
    "Transport &amp; weights",
    "JAYABHERI LOGISTICS",
    "Supplier Kata weight",
    "Not recorded",
    "GST",
    "₹4,46,435.33",
    "₹2,927",
    "₹29,23,705",
    "41.47",
    "SAP payload",
  ])
    assert.ok(html.includes(text), text);
  for (const text of [
    "Confirm draft",
    "Confirm final posting",
    "Create A/P Invoice Draft",
  ])
    assert.ok(!html.includes(text), text);
});
