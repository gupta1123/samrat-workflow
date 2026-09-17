import assert from "node:assert/strict";
import { test } from "node:test";

import {
  enrichProcessedDocuments,
  verifyProcessedDocuments,
  verifyWeightCalculationIntegrity,
} from "../src/server/processing/pipeline";
import type { CaseDoc } from "../src/types/pipeline";
import { WEIGHT_CALCULATION_FIELD } from "../src/lib/weight-calculation";

function doc(
  id: string,
  type: CaseDoc["type"],
  fields: CaseDoc["fields"],
  md: string,
): CaseDoc {
  return { id, type, title: id, pages: 1, fields, md };
}

test("visible and corroborated weight evidence repairs dropped OCR zeroes and omitted units", () => {
  const documents = enrichProcessedDocuments([
    doc(
      "lr-handwritten",
      "Lorry Receipt",
      { netWeight: "40.31", vehicleNumber: "TS02UC2700" },
      "Actual Kg. Charged Kg. 40.310MT",
    ),
    doc(
      "weighment",
      "Weighment Slip",
      {
        grossWeight: "5701",
        tareWeight: "1670",
        netWeight: "4031",
        vehicleNumber: "TS02UC2700",
      },
      "GROSS Wt: 5701 kg\nTARE Wt: 1670 kg\nNET Wt: 4031 kg\nFOUR ZERO THREE ONE ZERO kg",
    ),
    doc(
      "invoice",
      "Invoice",
      {
        itemQuantity: "40.310",
        unit: "TO",
        vehicleNumber: "TS02UC2700",
      },
      "Quantity (TO) 40.310",
    ),
    doc(
      "lr-printed",
      "Lorry Receipt",
      { netWeight: "40.31", vehicleNumber: "TS02UC2700" },
      "Despatched Quantity (MT) Net Wt. 40.310",
    ),
  ]);

  assert.equal(documents[0].fields.netWeight, "40.31 MT");
  assert.equal(documents[1].fields.netWeight, "40310 KG");
  assert.equal(documents[1].fields.grossWeight, "5701 KG");
  assert.equal(documents[1].fields.tareWeight, "1670 KG");
  assert.equal(documents[3].fields.netWeight, "40.31 MT");

  const result = verifyProcessedDocuments(documents, {
    considerFormatting: false,
  });
  assert.ok(
    !result.mismatches.some((mismatch) => mismatch.field === "netWeight"),
  );
  const weightCalculation = result.mismatches.find(
    (mismatch) => mismatch.field === WEIGHT_CALCULATION_FIELD,
  );
  assert.ok(weightCalculation);
  assert.match(weightCalculation.analysis ?? "", /Expected Net Weight: 4031 kg/);
  assert.match(weightCalculation.analysis ?? "", /Printed Net Weight: 40310 KG/);
});

test("spelled weight evidence stays conservative when multiple candidates exist", () => {
  const [weighment] = enrichProcessedDocuments([
    doc(
      "weighment",
      "Weighment Slip",
      { netWeight: "4031 kg" },
      "FOUR ZERO THREE ONE ZERO kg\nFOUR ZERO THREE ZERO ONE kg",
    ),
  ]);

  assert.equal(weighment.fields.netWeight, "4031 kg");
});

test("a source-consistent weighment triple remains intact", () => {
  const [weighment] = enrichProcessedDocuments([
    doc(
      "weighment",
      "Weighment Slip",
      {
        grossWeight: "57010 kg",
        tareWeight: "16700 kg",
        netWeight: "40310 kg",
      },
      "GROSS WT 57010 kg\nTARE WT 16700 kg\nNET WT 40310 kg\nFOUR ZERO THREE ONE ZERO kg",
    ),
  ]);

  assert.equal(weighment.fields.grossWeight, "57010 kg");
  assert.equal(weighment.fields.tareWeight, "16700 kg");
  assert.equal(weighment.fields.netWeight, "40310 kg");

  assert.equal(
    verifyWeightCalculationIntegrity([weighment]).length,
    0,
  );
});

test("an invalid gross-tare-net equation becomes a dedicated blocking issue", () => {
  const weighment = doc(
    "bad-weight-slip",
    "Weighment Slip",
    {
      grossWeight: "57,010 KG",
      tareWeight: "16,700 KG",
      netWeight: "40,100 KG",
    },
    "GROSS WT 57,010 KG\nTARE WT 16,700 KG\nNET WT 40,100 KG",
  );

  const issues = verifyWeightCalculationIntegrity([weighment]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, WEIGHT_CALCULATION_FIELD);
  assert.equal(issues[0].values[0].docId, weighment.id);
  assert.match(issues[0].analysis ?? "", /Expected Net Weight: 40310 kg/);
  assert.match(issues[0].analysis ?? "", /Difference: 210 kg/);
  assert.doesNotMatch(issues[0].analysis ?? "", /freight/i);
});

test("weight arithmetic normalizes compatible KG and MT values", () => {
  const weighment = doc(
    "mixed-unit-weight-slip",
    "Weighment Slip",
    {
      grossWeight: "46.810 MT",
      tareWeight: "16,100 KG",
      netWeight: "30.710 MT",
    },
    "GROSS 46.810 MT\nTARE 16,100 KG\nNET 30.710 MT",
  );

  assert.equal(verifyWeightCalculationIntegrity([weighment]).length, 0);
});
