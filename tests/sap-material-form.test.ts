import assert from "node:assert/strict";
import test from "node:test";

import {
  SAP_NON_MATERIAL_FORM,
  sapAutomaticMaterialForm,
  sapBaseRequiresMaterialForm,
} from "../src/lib/sap-material-form";

test("Open PO invoices do not require Material Form", () => {
  assert.equal(sapBaseRequiresMaterialForm("PO"), false);
  assert.equal(sapBaseRequiresMaterialForm("po"), false);
});

test("GRPO and unknown bases keep the Material Form safeguard", () => {
  assert.equal(sapBaseRequiresMaterialForm("GRPO"), true);
  assert.equal(sapBaseRequiresMaterialForm("grpo"), true);
  assert.equal(sapBaseRequiresMaterialForm(undefined), true);
});

test("Open PO non-material invoices automatically use STRAIGHT", () => {
  assert.equal(SAP_NON_MATERIAL_FORM, "ST");
  assert.equal(sapAutomaticMaterialForm("PO"), "ST");
  assert.equal(sapAutomaticMaterialForm(" po "), "ST");
});

test("GRPO and unknown bases do not get an automatic Material Form", () => {
  assert.equal(sapAutomaticMaterialForm("GRPO"), null);
  assert.equal(sapAutomaticMaterialForm(undefined), null);
});
