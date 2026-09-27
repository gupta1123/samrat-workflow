import assert from "node:assert/strict";
import test from "node:test";

import {
  SAP_NON_MATERIAL_FORM,
  sapMaterialFormPolicy,
} from "../src/lib/sap-material-form";

test("non-inventory Open PO invoices automatically use STRAIGHT", () => {
  assert.deepEqual(
    sapMaterialFormPolicy("PO", [{ InventoryItem: "tNO" }]),
    { required: false, automaticValue: SAP_NON_MATERIAL_FORM },
  );
});

test("service Open PO invoices without item codes automatically use STRAIGHT", () => {
  assert.deepEqual(sapMaterialFormPolicy("po", []), {
    required: false,
    automaticValue: SAP_NON_MATERIAL_FORM,
  });
});

test("inventory-item Open PO invoices require an explicit Material Form", () => {
  assert.deepEqual(
    sapMaterialFormPolicy("PO", [{ InventoryItem: "tYES" }]),
    { required: true, automaticValue: null },
  );
});

test("mixed Open PO invoices require an explicit Material Form", () => {
  assert.deepEqual(
    sapMaterialFormPolicy("PO", [
      { InventoryItem: "tNO" },
      { InventoryItem: "tYES" },
    ]),
    { required: true, automaticValue: null },
  );
});

test("GRPO and unknown bases keep the Material Form safeguard", () => {
  assert.deepEqual(sapMaterialFormPolicy("GRPO"), {
    required: true,
    automaticValue: null,
  });
  assert.deepEqual(sapMaterialFormPolicy(undefined), {
    required: true,
    automaticValue: null,
  });
});
