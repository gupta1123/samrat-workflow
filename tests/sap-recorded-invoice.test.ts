import assert from "node:assert/strict";
import { test } from "node:test";
import { recordedInvoiceEvidence } from "../src/server/sap/recorded-invoice";

const expected = {
  docEntry: 88,
  docNum: 902,
  cardCode: "V-GIFT",
  invoiceReference: "INV-445",
};
const document = {
  DocEntry: expected.docEntry,
  DocNum: expected.docNum,
  CardCode: expected.cardCode,
  NumAtCard: expected.invoiceReference,
  Cancelled: "tNO",
  DocCurrency: "USD",
  DocTotal: 150,
  DocumentLines: [
    {
      LineNum: 4,
      ItemCode: "EXP-24",
      ItemDescription: "Promotion expense",
      AccountCode: "AC-45",
      Quantity: 3,
      UnitPrice: 50,
      LineTotal: 150,
    },
  ],
};

test("recorded evidence retains actual accounting lines and amounts without grouping or product inference", () => {
  const evidence = recordedInvoiceEvidence(document, expected);
  assert.deepEqual(evidence, {
    ...expected,
    currency: "USD",
    total: 150,
    docDate: null,
    taxTotal: null,
    lines: [
      {
        lineNum: 4,
        itemCode: "EXP-24",
        description: "Promotion expense",
        accountCode: "AC-45",
        quantity: 3,
        unitPrice: 50,
        lineTotal: 150,
        base: null,
      },
    ],
  });
});

for (const change of [
  { DocEntry: 99 },
  { DocNum: 999 },
  { CardCode: "OTHER" },
  { NumAtCard: "INV-445-2" },
  { Cancelled: "tYES" },
  { Cancelled: undefined },
  { DocumentLines: undefined },
  { DocumentLines: [null] },
]) {
  test(`unverified recorded details are not shown: ${JSON.stringify(change)}`, () => {
    assert.equal(
      recordedInvoiceEvidence({ ...document, ...change }, expected),
      null,
    );
  });
}

test("account-based documents retain their account and do not invent an item or quantity", () => {
  const evidence = recordedInvoiceEvidence(
    {
      ...document,
      DocumentLines: [{ LineNum: 0, AccountCode: "AC-45", LineTotal: 0 }],
    },
    expected,
  )!;
  assert.equal(evidence.lines[0].itemCode, null);
  assert.equal(evidence.lines[0].quantity, null);
  assert.equal(evidence.lines[0].lineTotal, 0);
});

test("recorded evidence carries the SAP posting date and tax total", () => {
  const evidence = recordedInvoiceEvidence(
    { ...document, DocDate: "2026-07-03T00:00:00", VatSum: 18 } as never,
    expected,
  );
  assert.equal(evidence?.docDate, "2026-07-03");
  assert.equal(evidence?.taxTotal, 18);
});

test("a line keeps SAP's own PO or receipt reference and nothing else is inferred", () => {
  const evidence = recordedInvoiceEvidence(
    {
      ...document,
      DocumentLines: [
        {
          ...document.DocumentLines[0],
          BaseType: 22,
          BaseEntry: 57157,
          BaseLine: 1,
        },
        {
          ...document.DocumentLines[0],
          BaseType: 20,
          BaseEntry: 9,
          BaseLine: 0,
        },
        { ...document.DocumentLines[0], BaseType: -1, BaseEntry: null },
      ],
    } as never,
    expected,
  );
  assert.deepEqual(
    evidence?.lines.map((line) => line.base),
    [
      { kind: "PO", docEntry: 57157, docNum: null, lineNum: 1 },
      { kind: "GRPO", docEntry: 9, docNum: null, lineNum: 0 },
      null,
    ],
  );
});
