import assert from "node:assert/strict";
import test from "node:test";

import {
  learnedFieldUpdatePayload,
  learnedFieldsMatch,
  learnVendorInvoiceFieldUpdates,
} from "../src/server/sap/vendor-field-profile";

function invoice(input: {
  number: string | null;
  date: string;
  quantity: number;
  unit?: string;
  fields: Record<string, unknown>;
}) {
  return {
    NumAtCard: input.number,
    TaxDate: `${input.date}T00:00:00Z`,
    DocumentLines: [
      {
        Quantity: input.quantity,
        MeasureUnit: input.unit ?? "MTS",
      },
    ],
    ...input.fields,
  };
}

test("learns exact vendor fields from successful SAP invoices without field-name rules", () => {
  const history = [
    invoice({
      number: "INV-100",
      date: "2026-06-10",
      quantity: 12.5,
      fields: {
        U_X1: "INV-100",
        U_X2: "2026-06-10T00:00:00Z",
        U_X3: "12.5",
        U_UNRELATED: "keep",
      },
    }),
    invoice({
      number: "INV-101",
      date: "2026-06-11",
      quantity: 14.75,
      fields: {
        U_X1: "INV-101",
        U_X2: "2026-06-11T00:00:00Z",
        U_X3: "14.75",
        U_UNRELATED: "keep",
      },
    }),
  ];
  const draft = invoice({
    number: "INV-102",
    date: "2026-06-12",
    quantity: 9.25,
    fields: {},
  });

  const updates = learnVendorInvoiceFieldUpdates({
    draft,
    historicalInvoices: history,
  });

  assert.deepEqual(learnedFieldUpdatePayload(updates), {
    U_X1: "INV-102",
    U_X2: "2026-06-12",
    U_X3: "9.25",
  });
  assert.equal(
    learnedFieldsMatch(
      {
        ...draft,
        U_X1: "INV-102",
        U_X2: "2026-06-12T00:00:00Z",
        U_X3: "9.250",
      },
      updates,
    ),
    true,
  );
});

test("does not learn from one invoice or from inconsistent values", () => {
  const draft = invoice({
    number: "INV-102",
    date: "2026-06-12",
    quantity: 9.25,
    fields: {},
  });
  const oneInvoice = invoice({
    number: "INV-100",
    date: "2026-06-10",
    quantity: 12.5,
    fields: { U_CANDIDATE: "INV-100" },
  });
  assert.deepEqual(
    learnVendorInvoiceFieldUpdates({
      draft,
      historicalInvoices: [oneInvoice],
    }),
    [],
  );

  const inconsistent = invoice({
    number: "INV-101",
    date: "2026-06-11",
    quantity: 14.75,
    fields: { U_CANDIDATE: "something-else" },
  });
  assert.deepEqual(
    learnedFieldUpdatePayload(
      learnVendorInvoiceFieldUpdates({
        draft,
        historicalInvoices: [oneInvoice, inconsistent],
      }),
    ),
    {},
  );
});

test("quantity mappings require the same SAP unit as the new draft", () => {
  const history = [
    invoice({
      number: null,
      date: "",
      quantity: 10,
      unit: "NOS",
      fields: { U_WEIGHT: "10" },
    }),
    invoice({
      number: null,
      date: "",
      quantity: 20,
      unit: "NOS",
      fields: { U_WEIGHT: "20" },
    }),
  ];
  const draft = invoice({
    number: null,
    date: "",
    quantity: 30,
    unit: "MTS",
    fields: {},
  });

  assert.deepEqual(
    learnVendorInvoiceFieldUpdates({ draft, historicalInvoices: history }),
    [],
  );
});
