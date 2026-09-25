import assert from "node:assert/strict";
import { test } from "node:test";

import {
  sapTransportFieldUpdates,
  transportFieldsMatch,
} from "../src/server/sap/transport-fields";

test("copies a missing transport UDF from the exact SAP base document", () => {
  assert.deepEqual(
    sapTransportFieldUpdates(
      { U_TRSPRT: "None" },
      { U_TRSPRT: "Tata-One Point Supply Chain Solution" },
    ),
    { U_TRSPRT: "Tata-One Point Supply Chain Solution" },
  );
});

test("does not overwrite an existing transport value in the SAP draft", () => {
  assert.deepEqual(
    sapTransportFieldUpdates(
      { U_TRSPRT: "Existing Carrier" },
      { U_TRSPRT: "Base Carrier" },
    ),
    {},
  );
});

test("does not copy SAP placeholder values or unrelated UDFs", () => {
  assert.deepEqual(
    sapTransportFieldUpdates(
      { U_TRSPRT: null },
      { U_TRSPRT: "None", U_MATERIAL_FORM: "CL" },
    ),
    {},
  );
});

test("verifies that SAP persisted every copied transport field", () => {
  assert.equal(
    transportFieldsMatch(
      { U_TRSPRT: "Carrier A", U_transporterName: "Carrier A" },
      { U_TRSPRT: "Carrier A", U_transporterName: "Carrier A" },
    ),
    true,
  );
  assert.equal(
    transportFieldsMatch({ U_TRSPRT: "Carrier B" }, { U_TRSPRT: "Carrier A" }),
    false,
  );
});
