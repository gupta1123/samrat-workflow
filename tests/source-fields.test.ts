import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { getFieldKeysForDocType as frontendFields } from "../src/lib/document-schema";
import { getFieldKeysForDocType as backendFields } from "../src/server/document-schema";
import {
  serializeFieldsWithLineItems,
  readStoredLineItems,
  stripStoredLineItems,
} from "../src/server/line-items";
import { readStoredLogisticsRows } from "../src/lib/extracted-source-rows";
import type { CaseDoc } from "../src/types/pipeline";
import {
  sourceQuoteContainsValue,
  sourceFieldQuoteContainsValue,
} from "../src/server/processing/extraction-semantics";

test("invoice terms, component taxes and certificate licence roles survive both field schemas", () => {
  for (const keys of [frontendFields, backendFields]) {
    for (const type of ["Invoice", "Tax Invoice"])
      for (const field of [
        "paymentTerms",
        "materialValue",
        "totalTaxableAmount",
        "cgstAmount",
        "sgstAmount",
        "igstAmount",
      ])
        assert.ok(
          keys(type).includes(field as never),
          `${type} must allow ${field}`,
        );
    assert.ok(keys("Material Test Certificate").includes("bisLicenseNumber"));
    assert.ok(keys("Material Test Certificate").includes("certificateDate"));
    assert.ok(keys("Material Test Certificate").includes("documentDate"));
    assert.ok(keys("E-Way Bill").includes("itemDescription"));
  }
});

test("source proof rejects lost decimal values and permits equivalent numeric formatting", () => {
  assert.equal(sourceQuoteContainsValue("Quantity 41.800 TO", "41"), false);
  assert.equal(sourceQuoteContainsValue("Gross 49.190 TO", "49.1"), false);
  assert.equal(sourceQuoteContainsValue("Quantity 41.800 TO", "41.800"), true);
  assert.equal(sourceQuoteContainsValue("Quantity 41.800 TO", "41.8"), true);
  assert.equal(sourceQuoteContainsValue("Amount 480.00.", "480.00"), true);
  assert.equal(sourceQuoteContainsValue("Gross 149.190 TO", "49.190"), false);
  assert.equal(sourceQuoteContainsValue("Rate 58308.00", "58,308.00"), true);
  assert.equal(
    sourceQuoteContainsValue("Amount 2,437,274.41", "2437274.41"),
    true,
  );
  assert.equal(sourceQuoteContainsValue("Rate 58,308.19", "58308.1"), false);
  assert.equal(sourceQuoteContainsValue("Gross 149190", "49190"), false);
  assert.equal(sourceQuoteContainsValue("Steel\nbar", "Steel bar"), true);
  assert.equal(
    sourceQuoteContainsValue("TATA TISCON SD", "Tata Tiscon SD"),
    false,
  );
  assert.equal(
    sourceQuoteContainsValue("TATA TISCON SD", "Tata Tiscon Fe550D SD"),
    false,
  );
});

test("date evidence accepts only the same ordered components, without guessing", () => {
  assert.equal(
    sourceFieldQuoteContainsValue(
      "documentDate",
      "Date 16/6/2026",
      "16.06.2026",
    ),
    true,
  );
  assert.equal(
    sourceFieldQuoteContainsValue(
      "documentDate",
      "Date 6/16/2026",
      "16.06.2026",
    ),
    false,
  );
  assert.equal(
    sourceFieldQuoteContainsValue("documentDate", "Date 16/6/26", "16.06.2026"),
    false,
  );
  assert.equal(
    sourceFieldQuoteContainsValue(
      "invoiceNumber",
      "Ref 16/6/2026",
      "16.06.2026",
    ),
    false,
  );
});

test("separate source rows, tax components and row references round-trip without rewriting digits", () => {
  const document: CaseDoc = {
    id: "source",
    type: "Tax Invoice",
    title: "Invoice",
    pages: 1,
    md: "",
    fields: {
      paymentTerms: "30 days",
      materialValue: "2,437,274.41",
      cgstAmount: "227,834.24",
    },
    lineItems: [
      {
        description: "Steel",
        quantity: "41.800",
        unit: "TO",
        referencePoNumber: "PO-A",
        referenceGrpoNumber: "R-A",
      },
      {
        description: "Steel",
        quantity: "7.125",
        unit: "TO",
        referencePoNumber: "PO-B",
        referenceGrpoNumber: "R-B",
      },
    ],
    logisticsRows: [
      {
        kind: "transport",
        values: { vehicleNumber: "AP39VA1459" },
        sourcePage: 3,
        evidence: { vehicleNumber: "Vehicle AP39VA1459" },
      },
      {
        kind: "transport",
        values: { vehicleNumber: "KA51AC5439" },
        sourcePage: 3,
        evidence: { vehicleNumber: "Vehicle KA51AC5439" },
      },
      {
        kind: "weighment",
        values: {
          quantity: "15",
          unit: "NOS",
          grossWeight: "5",
          tareWeight: "1.25",
          netWeight: "3.75",
          weightUnit: "kg",
        },
        sourcePage: 4,
      },
    ],
  };
  const stored = serializeFieldsWithLineItems(document);
  assert.deepEqual(readStoredLogisticsRows(stored), document.logisticsRows);
  const lines = readStoredLineItems(stored);
  assert.equal(lines[0].quantity, "41.800");
  assert.equal(lines[0].referenceGrpoNumber, "R-A");
  assert.equal(lines[1].referencePoNumber, "PO-B");
  assert.equal(stripStoredLineItems(stored).materialValue, "2,437,274.41");
  assert.ok(!Object.hasOwn(stripStoredLineItems(stored), "__logisticsRows"));
});

test("manual migration is repeatable and preserves disabled settings and unconfigured defaults", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create table public.field_settings (
      organization_id text not null, doc_type text not null, field_key text not null,
      enabled boolean not null, unique(organization_id,doc_type,field_key));
      insert into public.field_settings values
      ('configured','Tax Invoice','invoiceNumber',true),
      ('configured','Tax Invoice','paymentTerms',false);`);
    const sql = readFileSync(
      new URL(
        "../supabase/migrations/20261014082406_source_extraction_fields_and_rows.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    const result = await db.query<{ field_key: string; enabled: boolean }>(
      "select field_key,enabled from public.field_settings order by field_key",
    );
    assert.equal(result.rows.length, 7);
    assert.equal(
      result.rows.find((row) => row.field_key === "paymentTerms")?.enabled,
      false,
    );
    assert.equal(
      result.rows.find((row) => row.field_key === "materialValue")?.enabled,
      true,
    );
    assert.equal(
      (
        await db.query(
          "select * from public.field_settings where doc_type='Invoice'",
        )
      ).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});
