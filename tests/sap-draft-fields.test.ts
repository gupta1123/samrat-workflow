import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDraftHeaderFields,
  draftWeightTonnes,
  DRAFT_FIELD_NAMES,
} from "../src/server/sap/draft-fields";
import type { MatchInvoice } from "../src/lib/sap-match/types";

const metadata = DRAFT_FIELD_NAMES.map((Name) => ({
  Name,
  TableName: "OPCH",
  Type: Name === "TATAINVDT" ? "db_Date" : "db_Alpha",
  EditSize: 100,
  ValidValuesMD:
    Name === "TRSPRT"
      ? [{ Value: "JAYABHERI LOGISTICS", Description: "Jayabheri Logistics" }]
      : Name === "MTRFORM"
        ? [
            { Value: "ST", Description: "ST" },
            { Value: "BT", Description: "BENT" },
          ]
        : [],
}));
const invoice = {
  invoiceNumber: "00123-A",
  invoiceDate: "2026-09-29",
  lines: [
    { index: 0, quantity: 2.5, unit: "MT", rate: 1000 },
    { index: 1, quantity: 1.5, unit: "MT", rate: 1200 },
  ],
} as MatchInvoice;
const documents = [
  {
    document_type: "Tax Invoice",
    extracted_fields: {
      invoiceNumber: "00123-A",
      documentDate: "29 Sep 2026",
      netWeight: "4 MT",
      materialForm: "BENT",
      transporterName: "Jayabheri Logistics",
    },
  },
  {
    document_type: "Weighment Slip",
    extracted_fields: {
      referenceInvoiceNumber: "00123-A",
      netWeight: "3980kg",
    },
  },
];
const build = (
  overrides: Partial<Parameters<typeof buildDraftHeaderFields>[0]> = {},
) =>
  buildDraftHeaderFields({
    invoice,
    documents,
    metadata,
    service: false,
    ...overrides,
  });

test("the seven confirmed fields use their own PDF sources and SAP data types", () => {
  const { values, preview } = build();
  assert.deepEqual(values, {
    U_TATAINV: "00123-A",
    U_TATAINVDT: "2026-09-29",
    U_TRSPRT: "JAYABHERI LOGISTICS",
    U_MTRFORM: "BT",
    U_TATKTW: "4",
    U_SAMKTW: "3.98",
    U_TOTQTY: "4",
  });
  assert.equal(
    preview.fields.find((field) => field.key === "U_SAMKTW")?.source,
    "Weighment slip net weight",
  );
});

test("another invoice's carrier and weight cannot contaminate the draft", () => {
  const result = build({
    documents: [
      ...documents,
      {
        document_type: "Tax Invoice",
        extracted_fields: {
          invoiceNumber: "OTHER",
          documentDate: "2026-09-29",
          netWeight: "80 MT",
          transporterName: "OTHER TRANSPORT",
        },
      },
      {
        document_type: "Weighment Slip",
        extracted_fields: {
          referenceInvoiceNumber: "OTHER",
          netWeight: "80000kg",
        },
      },
      {
        document_type: "Weighment Slip",
        extracted_fields: { netWeight: "80000kg" },
      },
    ],
  });
  assert.equal(result.values.U_SAMKTW, "3.98");
  assert.equal(result.values.U_TATKTW, "4");
  assert.equal(result.values.U_TRSPRT, "JAYABHERI LOGISTICS");
});

test("missing weights stay blank, invalid carriers need an explicit valid SAP choice", () => {
  const missing = [
    {
      document_type: "Invoice",
      extracted_fields: {
        invoiceNumber: "00123-A",
        documentDate: "2026-09-29",
        transporterName: "Fictional Carrier",
      },
    },
  ];
  const result = build({ documents: missing });
  assert.equal(result.values.U_TATKTW, null);
  assert.equal(result.values.U_SAMKTW, null);
  assert.equal(result.preview.transporter.selectedValue, "");
  assert.equal(result.preview.materialForm.selectedValue, "");
  assert.match(result.preview.warnings[0], /Fictional Carrier/);
  assert.throws(
    () =>
      build({ documents: missing, choices: { transporter: "UNCONFIGURED" } }),
    /not allowed/,
  );
  const chosen = build({
    documents: missing,
    choices: { transporter: "JAYABHERI LOGISTICS", materialForm: "ST" },
  });
  assert.equal(chosen.values.U_TRSPRT, "JAYABHERI LOGISTICS");
  assert.equal(chosen.values.U_MTRFORM, "ST");
  assert.equal(
    chosen.preview.fields.find((field) => field.key === "U_TRSPRT")?.source,
    "Selected for this draft",
  );
});

test("weight units, conflicting weighments and mixed invoice units are not guessed", () => {
  assert.equal(draftWeightTonnes("41,470kg"), 41.47);
  assert.equal(draftWeightTonnes("41.47 MTS"), 41.47);
  assert.equal(draftWeightTonnes("41470"), null);
  assert.equal(draftWeightTonnes("5 lb"), null);
  const result = build({
    documents: [
      ...documents,
      {
        document_type: "Weighment Slip",
        extracted_fields: {
          referenceInvoiceNumber: "00123-A",
          netWeight: "7 MT",
        },
      },
    ],
    invoice: {
      ...invoice,
      lines: [...invoice.lines, { ...invoice.lines[0], index: 2, unit: "PCS" }],
    },
  });
  assert.equal(result.values.U_SAMKTW, null);
  assert.equal(result.values.U_TOTQTY, null);
  assert.equal(result.preview.warnings.length, 2);
});

test("missing or duplicate metadata and conflicting invoice dates prevent draft preparation", () => {
  assert.throws(() => build({ metadata: metadata.slice(1) }), /one TATAINV/);
  assert.throws(
    () => build({ metadata: [...metadata, metadata[0]] }),
    /one TATAINV/,
  );
  assert.throws(
    () =>
      build({
        documents: [
          ...documents,
          {
            document_type: "Tax Invoice",
            extracted_fields: {
              invoiceNumber: "00123-A",
              documentDate: "2026-09-30",
            },
          },
        ],
      }),
    /date is missing or conflicting/,
  );
  assert.throws(
    () =>
      build({ metadata: metadata.map((field) => ({ ...field, EditSize: 2 })) }),
    /character limit/,
  );
});
