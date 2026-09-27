import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCounterpartySource,
  assertReferenceGrounding,
} from "../src/server/processing/semantic-grounding";
import type { CaseDoc } from "../src/types/pipeline";

const document: CaseDoc = {
  id: "transport-page",
  type: "E-Way Bill",
  title: "Transport record",
  pages: 1,
  fields: { referenceInvoiceNumber: "AC/26-27/417" },
  md: "",
  sourceFileName: "dispatch.pdf",
  sourcePageNumbers: [3],
};
const evidence = {
  field: "referenceInvoiceNumber",
  value: "AC/26-27/417",
  sourceLabel: "Document No",
  valueKind: "reference",
  sourceFileName: "dispatch.pdf",
  pageNumber: 3,
  quote: "Document No: AC/26-27/417",
};
const pages = [
  { sourceFileName: "dispatch.pdf", pageNumber: 2 },
  { sourceFileName: "dispatch.pdf", pageNumber: 3 },
];
const check = (proofs: unknown, doc = document) =>
  assertReferenceGrounding({
    document: doc,
    evidence: proofs,
    sourcePages: pages,
  });

test("retained references require the exact final value, visible label and own-page provenance", () => {
  assert.equal(check([evidence]).length, 1);
  for (const bad of [
    { ...evidence, value: "AC/26-27/419" },
    { ...evidence, sourceLabel: "Invoice No" },
    { ...evidence, quote: "Document No:" },
    { ...evidence, pageNumber: 2 },
    { ...evidence, sourceFileName: "other.pdf" },
    { ...evidence, field: "poNumber" },
  ])
    assert.throws(() => check([bad]), /Invalid semantic reference evidence/);
  assert.throws(() => check(undefined), /Missing referenceEvidence/);
  assert.throws(() => check([]), /Missing semantic reference evidence/);
  assert.throws(
    () => check([evidence, evidence]),
    /Invalid semantic reference evidence/,
  );
});

test("wrapped or respaced print still grounds the exact label and value", () => {
  const vehicle: CaseDoc = {
    ...document,
    fields: { vehicleNumber: "NL01AD8743" },
  };
  const vehicleEvidence = {
    field: "vehicleNumber",
    value: "NL01AD8743",
    sourceLabel: "Vehicle No.",
    valueKind: "reference",
    sourceFileName: "dispatch.pdf",
    pageNumber: 3,
    quote: "Vehicle No. : NL 01 AD 8743",
  };
  assert.equal(
    check([vehicleEvidence], vehicle).length,
    1,
  );
  const irn =
    "48c362f7275ba125156bf869bd8ff7cefe627daf1ceeea421c0f146808086f56e6";
  const irnDoc: CaseDoc = {
    ...document,
    fields: { irnNumber: irn },
  };
  assert.equal(
    check(
      [
        {
          field: "irnNumber",
          value: irn,
          sourceLabel: "IRN",
          valueKind: "reference",
          sourceFileName: "dispatch.pdf",
          pageNumber: 3,
          quote: `IRN :\n${irn.slice(0, 32)}\n${irn.slice(32)}`,
        },
      ],
      irnDoc,
    ).length,
    1,
  );
  // A different value or label is still rejected after normalization.
  assert.throws(
    () => check([{ ...vehicleEvidence, value: "NL01AD8744" }], vehicle),
    /Invalid semantic reference evidence/,
  );
  assert.throws(
    () => check([{ ...vehicleEvidence, sourceLabel: "Challan No." }], vehicle),
    /Invalid semantic reference evidence/,
  );
});

test("visible document categories cannot be attested as retained identifiers", () => {
  const doc = {
    ...document,
    fields: { referenceInvoiceNumber: "TAX INVOICE" },
  };
  assert.throws(
    () =>
      check(
        [
          {
            ...evidence,
            value: "TAX INVOICE",
            sourceLabel: "Document Details",
            valueKind: "document_type",
            quote: "Document Details: TAX INVOICE",
          },
        ],
        doc,
      ),
    /Invalid semantic reference evidence/,
  );
});

test("grounding has no identifier format or prohibited-word lookup", () => {
  for (const value of [
    "TAX INVOICE/26/417",
    "Letter of award September",
    "α/चालान/४१७",
  ]) {
    const doc = { ...document, fields: { referenceInvoiceNumber: value } };
    assert.equal(
      check([{ ...evidence, value, quote: `Document No: ${value}` }], doc)
        .length,
      1,
    );
  }
});

test("an absent or removed reference needs no fabricated proof", () => {
  assert.deepEqual(check([], { ...document, fields: {} }), []);
  assert.throws(
    () => check([evidence], { ...document, fields: {} }),
    /Invalid semantic reference evidence/,
  );
});

const invoice: CaseDoc = {
  id: "supplier-invoice",
  type: "Tax Invoice",
  title: "Invoice",
  pages: 1,
  md: "",
  fields: {
    vendorName: "Arden Steel Private Limited",
    buyerName: "Purchasing Works Limited",
    transporterName: "Express Carriers",
  },
};

test("purchase title cites the exact reviewed supplier, not buyer, carrier or an invented abbreviation", () => {
  const params = {
    counterpartyName: "Arden Steel Private Limited",
    documents: [invoice],
    source: { docId: invoice.id, field: "vendorName" },
  };
  assert.deepEqual(assertCounterpartySource(params), params.source);
  assert.throws(
    () =>
      assertCounterpartySource({
        ...params,
        counterpartyName: "Purchasing Works Limited",
        source: { docId: invoice.id, field: "buyerName" },
      }),
    /not bound/,
  );
  assert.throws(
    () =>
      assertCounterpartySource({ ...params, counterpartyName: "Arden Steel" }),
    /not bound/,
  );
  assert.throws(
    () =>
      assertCounterpartySource({
        ...params,
        counterpartyName: "Express Carriers",
        source: { docId: invoice.id, field: "transporterName" },
      }),
    /supplier role/,
  );
  assert.throws(
    () => assertCounterpartySource({ ...params, source: null }),
    /not bound/,
  );
});

test("mother-bill context cannot supply the purchase counterparty title", () => {
  const mother = {
    ...invoice,
    id: "upstream",
    fields: {
      vendorName: "Upstream Mill",
      buyerName: "Arden Steel Private Limited",
    },
  };
  const params = {
    documents: [mother, invoice],
    primaryDocumentIds: [invoice.id],
    contextDocumentIds: [mother.id],
  };
  assert.throws(
    () =>
      assertCounterpartySource({
        ...params,
        counterpartyName: "Upstream Mill",
        source: { docId: mother.id, field: "vendorName" },
      }),
    /not bound/,
  );
  assert.ok(
    assertCounterpartySource({
      ...params,
      counterpartyName: "Arden Steel Private Limited",
      source: { docId: invoice.id, field: "vendorName" },
    }),
  );
});

test("standalone KYC subjects and genuinely unknown counterparties remain supported", () => {
  const kyc: CaseDoc = {
    ...invoice,
    type: "Vehicle Registration Certificate",
    fields: { ownerName: "A. Kumar" },
  };
  assert.ok(
    assertCounterpartySource({
      documents: [kyc],
      counterpartyName: "A. Kumar",
      source: { docId: kyc.id, field: "ownerName" },
    }),
  );
  assert.equal(
    assertCounterpartySource({
      documents: [],
      counterpartyName: "",
      source: null,
    }),
    null,
  );
});
