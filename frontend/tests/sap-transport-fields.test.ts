import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveSapTransporter,
  sapTransportFieldUpdates,
  transportFieldsMatch,
} from "../src/server/sap/transport-fields";

const options = [
  { value: "PARTY VEHICLE", label: "PARTY VEHICLE" },
  { value: "PARAS HEAVY CARRIERS", label: "PARAS HEAVY CARRIERS" },
];

test("copies a missing transport UDF from the exact SAP base document", () => {
  assert.deepEqual(
    sapTransportFieldUpdates({ U_TRSPRT: "None" }, "U_TRSPRT", "PARTY VEHICLE"),
    { U_TRSPRT: "PARTY VEHICLE" },
  );
});

test("does not overwrite an existing transport value in the SAP draft", () => {
  assert.deepEqual(
    sapTransportFieldUpdates(
      { U_TRSPRT: "Existing Carrier" },
      "U_TRSPRT",
      "PARTY VEHICLE",
    ),
    {},
  );
});

test("uses the exact configured transporter from the SAP base document", () => {
  assert.deepEqual(
    resolveSapTransporter({
      draftValue: "None",
      baseValue: "paras heavy carriers",
      packetDocuments: [],
      invoiceNumber: "INV-1",
      allowedOptions: options,
    }),
    {
      status: "selected",
      value: "PARAS HEAVY CARRIERS",
      label: "PARAS HEAVY CARRIERS",
      source: "base",
    },
  );
});

test("uses exact packet evidence linked to the invoice when the SAP base is blank", () => {
  assert.deepEqual(
    resolveSapTransporter({
      draftValue: null,
      baseValue: "None",
      packetDocuments: [
        {
          extracted_fields: {
            referenceInvoiceNumber: "NVG/26-27/9713",
            transporterName: "PARTY VEHICLE",
          },
        },
        {
          extracted_fields: {
            referenceInvoiceNumber: "ANOTHER-INVOICE",
            transporterName: "PARAS HEAVY CARRIERS",
          },
        },
      ],
      invoiceNumber: "NVG/26-27/9713",
      allowedOptions: options,
    }),
    {
      status: "selected",
      value: "PARTY VEHICLE",
      label: "PARTY VEHICLE",
      source: "packet",
    },
  );
});

test("rejects a packet carrier that SAP does not allow instead of guessing", () => {
  assert.deepEqual(
    resolveSapTransporter({
      draftValue: null,
      baseValue: null,
      packetDocuments: [
        {
          extracted_fields: {
            invoiceNumber: "INV-2",
            transporterName: "UNCONFIGURED CARRIER",
          },
        },
      ],
      invoiceNumber: "INV-2",
      allowedOptions: options,
    }),
    { status: "invalid", candidates: ["UNCONFIGURED CARRIER"] },
  );
});

test("does not borrow transporter evidence from an unrelated invoice", () => {
  assert.deepEqual(
    resolveSapTransporter({
      draftValue: null,
      baseValue: null,
      packetDocuments: [
        {
          extracted_fields: {
            referenceInvoiceNumber: "OTHER-1",
            transporterName: "PARTY VEHICLE",
          },
        },
      ],
      invoiceNumber: "INV-3",
      allowedOptions: options,
    }),
    { status: "missing" },
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
