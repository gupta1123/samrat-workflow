import assert from "node:assert/strict";
import test from "node:test";
import {
  packetLogisticsFieldUpdates,
  packetLogisticsFieldsMatch,
  packetLogisticsUpdatePayload,
} from "../src/server/sap/packet-logistics-fields";

type SapField = Record<string, unknown>;

const fieldsByDescription: Record<string, SapField[]> = {
  "Vehicle NO": [{ Name: "DYNAMIC_VEHICLE" }],
  "Driver Name": [{ Name: "DYNAMIC_DRIVER" }],
  "Driver Mobile": [{ Name: "DYNAMIC_MOBILE" }],
  "LR No": [{ Name: "DYNAMIC_LR" }],
  "LR Date": [{ Name: "DYNAMIC_LR_DATE" }],
  "Waybill No.": [{ Name: "DYNAMIC_WAYBILL" }],
  "Weighbridge Transaction Id": [{ Name: "DYNAMIC_WEIGHMENT" }],
  "Vehicle Type": [
    {
      Name: "DYNAMIC_VEHICLE_TYPE_CODE",
      ValidValuesMD: [{ Value: "3", Description: "TRAILER" }],
    },
    { Name: "DYNAMIC_VEHICLE_TYPE_TEXT" },
  ],
  "Tata Kata Weight": [{ Name: "DYNAMIC_TATA_NET" }],
  "Samrat Kata Wt": [{ Name: "DYNAMIC_SAMRAT_NET" }],
  "TATA Gross Weight": [{ Name: "DYNAMIC_TATA_GROSS" }],
  "Tata Tare Weight": [{ Name: "DYNAMIC_TATA_TARE" }],
  "Samrat Gross Weight": [{ Name: "DYNAMIC_SAMRAT_GROSS" }],
  "Samrat Tare Weight": [{ Name: "DYNAMIC_SAMRAT_TARE" }],
};

const getUserFields = async (_table: string, description: string) =>
  fieldsByDescription[description] ?? [];

test("packet logistics fields use live SAP metadata and unique packet evidence", async () => {
  const updates = await packetLogisticsFieldUpdates({
    draft: {},
    invoiceNumber: "INV-100",
    getUserFields,
    documents: [
      {
        document_type: "Tax Invoice",
        extracted_fields: {
          invoiceNumber: "INV-100",
          vehicleNumber: "AP39TT6469",
          vehicleClass: "TRAILER",
          grossWeight: "56.79 MT",
          tareWeight: "17.23 MT",
          netWeight: "39.56 MT",
        },
      },
      {
        document_type: "Lorry Receipt",
        extracted_fields: {
          referenceInvoiceNumber: "INV-100",
          lorryReceiptNumber: "LR-778",
          documentDate: "2026-06-18",
          driverName: "RAJESH",
          driverMobile: "9000000009",
          vehicleNumber: "AP39TT6469",
        },
      },
      {
        document_type: "E-Way Bill",
        extracted_fields: {
          referenceInvoiceNumber: "INV-100",
          eWayBillNumber: "132461923775",
          vehicleNumber: "AP39TT6469",
        },
      },
      {
        document_type: "Weighment Slip",
        extracted_fields: {
          referenceInvoiceNumber: "INV-100",
          weighmentNumber: "PT10136",
          vehicleNumber: "AP39TT6469",
          grossWeight: "56790 KG",
          tareWeight: "17230 KG",
          netWeight: "39560 KG",
        },
      },
    ],
  });

  assert.deepEqual(packetLogisticsUpdatePayload(updates), {
    U_DYNAMIC_VEHICLE: "AP39TT6469",
    U_DYNAMIC_DRIVER: "RAJESH",
    U_DYNAMIC_MOBILE: "9000000009",
    U_DYNAMIC_LR: "LR-778",
    U_DYNAMIC_LR_DATE: "2026-06-18",
    U_DYNAMIC_WAYBILL: "132461923775",
    U_DYNAMIC_WEIGHMENT: "PT10136",
    U_DYNAMIC_VEHICLE_TYPE_CODE: "3",
    U_DYNAMIC_VEHICLE_TYPE_TEXT: "TRAILER",
    U_DYNAMIC_TATA_NET: 39.56,
    U_DYNAMIC_SAMRAT_NET: 39.56,
    U_DYNAMIC_TATA_GROSS: 56.79,
    U_DYNAMIC_TATA_TARE: 17.23,
    U_DYNAMIC_SAMRAT_GROSS: 56.79,
    U_DYNAMIC_SAMRAT_TARE: 17.23,
  });
});

test("conflicting packet evidence is not sent to SAP", async () => {
  const updates = await packetLogisticsFieldUpdates({
    draft: {},
    invoiceNumber: "INV-100",
    getUserFields,
    documents: [
      {
        document_type: "Tax Invoice",
        extracted_fields: {
          invoiceNumber: "INV-100",
          vehicleNumber: "AP39TT6469",
        },
      },
      {
        document_type: "E-Way Bill",
        extracted_fields: {
          referenceInvoiceNumber: "INV-100",
          vehicleNumber: "AP39TT1357",
        },
      },
    ],
  });

  assert.equal(
    updates.some((update) => update.description === "Vehicle NO"),
    false,
  );
});

test("multi-invoice packets use only documents linked to the selected invoice", async () => {
  const updates = await packetLogisticsFieldUpdates({
    draft: {},
    invoiceNumber: "INV-200",
    getUserFields,
    documents: [
      {
        document_type: "Tax Invoice",
        extracted_fields: {
          invoiceNumber: "INV-100",
          vehicleNumber: "AP39TT6469",
        },
      },
      {
        document_type: "Tax Invoice",
        extracted_fields: {
          invoiceNumber: "INV-200",
          vehicleNumber: "AP39TT1357",
        },
      },
    ],
  });

  assert.equal(
    packetLogisticsUpdatePayload(updates).U_DYNAMIC_VEHICLE,
    "AP39TT1357",
  );
});

test("saved SAP logistics values are verified after the draft update", () => {
  const updates = [
    {
      description: "Vehicle NO",
      propertyName: "U_DYNAMIC_VEHICLE",
      value: "AP39TT6469",
    },
    {
      description: "Samrat Gross Weight",
      propertyName: "U_DYNAMIC_SAMRAT_GROSS",
      value: 56.79,
    },
  ];
  assert.equal(
    packetLogisticsFieldsMatch(
      {
        U_DYNAMIC_VEHICLE: "AP39TT6469",
        U_DYNAMIC_SAMRAT_GROSS: 56.79,
      },
      updates,
    ),
    true,
  );
  assert.equal(
    packetLogisticsFieldsMatch(
      {
        U_DYNAMIC_VEHICLE: "AP39TT1357",
        U_DYNAMIC_SAMRAT_GROSS: 56.79,
      },
      updates,
    ),
    false,
  );
});

test("LR dates preserve the packet's calendar day and skip matching SAP timestamps", async () => {
  for (const documentDate of [
    "17 Jun 2026",
    "17/06/2026",
    "2026-06-17T00:00:00+05:30",
  ]) {
    const input = {
      invoiceNumber: "INV-100",
      getUserFields,
      documents: [
        {
          document_type: "Lorry Receipt",
          extracted_fields: { documentDate },
        },
      ],
    };
    const updates = await packetLogisticsFieldUpdates({ ...input, draft: {} });
    assert.equal(
      packetLogisticsUpdatePayload(updates).U_DYNAMIC_LR_DATE,
      "2026-06-17",
    );
    assert.equal(
      packetLogisticsFieldsMatch(
        { U_DYNAMIC_LR_DATE: "2026-06-17T00:00:00Z" },
        updates,
      ),
      true,
    );
    assert.deepEqual(
      await packetLogisticsFieldUpdates({
        ...input,
        draft: {
          U_DYNAMIC_LR_DATE: "2026-06-17T00:00:00Z",
        },
      }),
      [],
    );
  }
});

test("LR date verification rejects different days and invalid dates without normalizing text references", () => {
  const updates = [
    { description: "LR Date", propertyName: "U_LRDT", value: "2026-06-17" },
  ];
  assert.equal(
    packetLogisticsFieldsMatch({ U_LRDT: "2026-06-16T00:00:00Z" }, updates),
    false,
  );
  assert.equal(packetLogisticsFieldsMatch({ U_LRDT: null }, updates), false);
  assert.equal(
    packetLogisticsFieldsMatch({ U_LRDT: "2026-02-31T00:00:00Z" }, [
      { description: "LR Date", propertyName: "U_LRDT", value: "2026-02-31" },
    ]),
    false,
  );
  assert.equal(
    packetLogisticsFieldsMatch({ U_LRNO: "2026-06-17T00:00:00Z" }, [
      { description: "LR No", propertyName: "U_LRNO", value: "2026-06-17" },
    ]),
    false,
  );
});
