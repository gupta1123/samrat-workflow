import assert from "node:assert/strict";
import test from "node:test";

import { sapBaseRequiresMaterialForm } from "../src/lib/sap-material-form";

test("Open PO invoices do not require Material Form", () => {
  assert.equal(sapBaseRequiresMaterialForm("PO"), false);
  assert.equal(sapBaseRequiresMaterialForm("po"), false);
});

test("GRPO and unknown bases keep the Material Form safeguard", () => {
  assert.equal(sapBaseRequiresMaterialForm("GRPO"), true);
  assert.equal(sapBaseRequiresMaterialForm("grpo"), true);
  assert.equal(sapBaseRequiresMaterialForm(undefined), true);
});
