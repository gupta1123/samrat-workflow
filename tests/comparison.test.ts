import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifyCaseDocuments,
  verifyGroupedCaseDocuments,
} from "../src/server/services/verification";
import { sanitizeFieldsForDocType } from "../src/server/document-schema";
import { sanitizeFieldsForDocType as sanitizeDisplayFields } from "../src/lib/document-schema";
import {
  enrichDocumentsWithPacketGstTaxContext,
  enrichFieldsWithLineItemTaxRates,
  sanitizeLineItems,
} from "../src/server/line-items";
import {
  selectCaseSummaryDocuments,
  summarizeCase,
} from "../src/server/case-summary";
import type { CaseDoc } from "../src/types/pipeline";
const invoice: CaseDoc = {
  id: "invoice",
  type: "Invoice",
  title: "Invoice",
  pages: 1,
  fields: {
    invoiceNumber: "INV-001",
    referencePoNumber: "PO-001",
    buyerName: "Samrat Group",
    vendorName: "Example supplier",
    totalAmount: "118000",
    currency: "INR",
  },
  md: "",
};
const linkedDocument: CaseDoc = {
  id: "eway",
  type: "E-Way Bill",
  title: "E-Way Bill",
  pages: 1,
  fields: {
    referenceInvoiceNumber: "INV-001",
    buyerName: "Samrat Group",
    vendorName: "Example supplier",
    totalAmount: "120000",
    currency: "INR",
  },
  md: "",
};

test("line-item sanitization preserves standards and grades inside descriptions", () => {
  assert.deepEqual(
    sanitizeLineItems([
      {
        description: "MS PLATES IS 2062 E250",
        hsnSac: "7208",
        quantity: "10",
        unit: "MT",
      },
    ]),
    [
      {
        description: "MS PLATES IS 2062 E250",
        hsnSac: "7208",
        quantity: "10",
        unit: "MT",
      },
    ],
  );
});

test("comparison detects a real amount difference without a company-specific identity", () => {
  assert.ok(
    verifyCaseDocuments([invoice, linkedDocument]).some(
      (m) => m.field === "totalAmount",
    ),
  );
});
test("matching packet amounts do not produce an amount mismatch", () => {
  const matched = {
    ...linkedDocument,
    fields: { ...linkedDocument.fields, totalAmount: "118000" },
  };
  assert.ok(
    !verifyCaseDocuments([invoice, matched]).some(
      (m) => m.field === "totalAmount",
    ),
  );
});

test("delivery order and delivery note references remain separate business fields", () => {
  const invoiceWithTwoDeliveryReferences: CaseDoc = {
    ...invoice,
    fields: {
      ...invoice.fields,
      deliveryOrderNumber: "DO-900",
      deliveryNoteNumber: "DN-120",
    },
  };
  const lorryReceipt: CaseDoc = {
    id: "transport",
    type: "Lorry Receipt",
    title: "Lorry Receipt",
    pages: 1,
    fields: { deliveryNoteNumber: "DN-120" },
    md: "Delivery DN-120",
  };

  const mismatches = verifyCaseDocuments([
    invoiceWithTwoDeliveryReferences,
    lorryReceipt,
  ]);
  assert.ok(
    !mismatches.some(
      (entry) =>
        entry.field === "deliveryOrderNumber" ||
        entry.field === "deliveryNoteNumber",
    ),
  );
});

test("complete conflicting IRNs are surfaced for review", () => {
  const invoiceWithIrn: CaseDoc = {
    ...invoice,
    type: "Tax Invoice",
    fields: {
      ...invoice.fields,
      irnNumber:
        "b758281f7e443abfbec49567da2987a825981f366e2cb893a572eba9a63fdc9b",
    },
  };
  const ewayWithIrn: CaseDoc = {
    ...linkedDocument,
    fields: {
      ...linkedDocument.fields,
      irnNumber:
        "6758281f7e443abfbec49567da2987a825981f366e2cb893a572eba9a63fdc9b",
    },
  };

  assert.ok(
    verifyCaseDocuments([invoiceWithIrn, ewayWithIrn]).some(
      (mismatch) => mismatch.field === "irnNumber",
    ),
  );
});

test("a printed reference does not pretend the actual PO or weight slip was uploaded", () => {
  const summary = summarizeCase(
    [
      {
        ...invoice,
        type: "Tax Invoice",
        fields: {
          ...invoice.fields,
          referencePoNumber: "EMAIL-TG Regular",
          eWayBillNumber: "401758480920",
        },
      },
      {
        ...linkedDocument,
        fields: {
          ...linkedDocument.fields,
          eWayBillNumber: "401758480920",
        },
      },
      {
        id: "lr",
        type: "Lorry Receipt",
        title: "Lorry Receipt",
        pages: 1,
        fields: {
          referencePoNumber: "EMAIL-TG Regular",
          lorryReceiptNumber: "PH2322707379",
        },
        md: "",
      },
    ],
    [],
  );

  assert.deepEqual(summary.missingDocTypes, ["Purchase Order", "Weight Proof"]);
  assert.equal(summary.riskScore, 24);
});

test("metric tonnes normalize when the unit is printed without a space", () => {
  const lorryReceipt: CaseDoc = {
    id: "lr",
    type: "Lorry Receipt",
    title: "Lorry Receipt",
    pages: 1,
    fields: { netWeight: "40.310MT" },
    md: "Net weight 40.310MT",
  };
  const weighment: CaseDoc = {
    id: "weight",
    type: "Weighment Slip",
    title: "Weighment Slip",
    pages: 1,
    fields: { netWeight: "40310 KG" },
    md: "Net weight 40310 KG",
  };

  assert.ok(
    !verifyCaseDocuments([lorryReceipt, weighment]).some(
      (mismatch) => mismatch.field === "netWeight",
    ),
  );
});
test("purchase-order grand totals are not compared with a partial invoice", () => {
  const purchaseOrder: CaseDoc = {
    ...linkedDocument,
    type: "Purchase Order",
    fields: { poNumber: "PO-001", totalAmount: "250000" },
  };
  assert.ok(
    !verifyCaseDocuments([invoice, purchaseOrder]).some(
      (m) => m.field === "totalAmount",
    ),
  );
});
test("one GSTIN does not imply a home state or fabricate a GST split", () => {
  const fields = enrichFieldsWithLineItemTaxRates(
    { supplierGstin: "27ABCDE1234F1Z5", taxRate: "18" },
    [],
  );
  assert.equal(fields.cgstRate, undefined);
  assert.equal(fields.sgstRate, undefined);
  assert.equal(fields.igstRate, undefined);
});

test("packet GST context does not fabricate logistics tax fields or GSTINs", () => {
  const taxInvoice: CaseDoc = {
    ...invoice,
    type: "Tax Invoice",
    fields: {
      ...invoice.fields,
      supplierGstin: "37AAACT2803M1ZA",
      buyerGstin: "36AAQCS9189P1ZY",
      subtotal: "100",
      taxAmount: "18",
      totalAmount: "118",
    },
  };
  const lorryReceipt: CaseDoc = {
    id: "lr",
    type: "Lorry Receipt",
    title: "Lorry Receipt",
    pages: 1,
    fields: { supplierGstin: "37AAACT2803M1ZA" },
    md: "Consigner GST Reg. No. 37AAACT2803M1ZA",
  };

  const [, enrichedLorryReceipt] = enrichDocumentsWithPacketGstTaxContext([
    taxInvoice,
    lorryReceipt,
  ]);
  assert.equal(enrichedLorryReceipt.fields.buyerGstin, undefined);
  assert.equal(enrichedLorryReceipt.fields.taxRate, undefined);
  assert.equal(enrichedLorryReceipt.fields.igstRate, undefined);
});

test("a weighment's printed PO reference links it to its case without merging another shipment", () => {
  const weighing: CaseDoc = {
    id: "weighment",
    type: "Weighment Slip",
    title: "Weighment",
    pages: 1,
    fields: {
      referencePoNumber: "PO-001",
      referenceInvoiceNumber: "INV-001",
      weighmentNumber: "WB-001",
      vendorName: "Example supplier",
      netWeight: "9700",
    },
    md: "PO reference: PO-001. Invoice reference: INV-001. Net weight: 9700 KG.",
  };
  const otherInvoice: CaseDoc = {
    ...invoice,
    id: "other-invoice",
    fields: {
      ...invoice.fields,
      invoiceNumber: "INV-002",
      referencePoNumber: "PO-002",
      totalAmount: "240000",
    },
  };
  for (const sanitize of [sanitizeFieldsForDocType, sanitizeDisplayFields]) {
    const sanitized = {
      ...weighing,
      fields: sanitize("Weighment Slip", weighing.fields),
    };
    const { groups } = verifyGroupedCaseDocuments([
      invoice,
      otherInvoice,
      sanitized,
    ]);
    assert.equal(groups.length, 2);
    const weightGroup = groups.find((g) => g.documentIds.includes("weighment"));
    assert.ok(weightGroup?.documentIds.includes("invoice"));
    assert.ok(!weightGroup?.documentIds.includes("other-invoice"));
  }
});

test("pages in one PDF sharing an invoice stay in one verification group despite party OCR differences", () => {
  const sourceFileName = "4725014558_0001.pdf";
  const lorryReceipt: CaseDoc = {
    id: "lr",
    type: "Lorry Receipt",
    title: "Lorry Receipt",
    pages: 1,
    sourceFileName,
    fields: {
      referenceInvoiceNumber: "4725014558",
      vendorName: "BEEKAY STEEL INDUSTRIES LIMITED",
    },
    md: "",
  };
  const taxInvoice: CaseDoc = {
    ...invoice,
    id: "tax-invoice",
    type: "Tax Invoice",
    sourceFileName,
    fields: {
      ...invoice.fields,
      invoiceNumber: "4725014558",
      vendorName: "TATA STEEL LIMITED",
      referencePoNumber: "9520040718",
    },
  };

  const { groups } = verifyGroupedCaseDocuments([lorryReceipt, taxInvoice]);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    new Set(groups[0].documentIds),
    new Set(["lr", "tax-invoice"]),
  );
});

test("a mother bill is detected without a PO when the downstream invoice faces the configured company", () => {
  const previousInternalNames = process.env.INTERNAL_COMPANY_NAMES;
  process.env.INTERNAL_COMPANY_NAMES = "Samrat Group,Samrat Irons Private Limited";

  try {
    const downstreamInvoice: CaseDoc = {
      ...invoice,
      id: "downstream-invoice",
      sourceFileName: "mother-bill-packet.pdf",
      fields: {
        invoiceNumber: "DIST-101",
        vendorName: "Distributor One",
        supplierGstin: "27CCCCC0000C1Z5",
        buyerName: "Samrat Irons Private Limited",
        buyerGstin: "36AAQCS9189P1ZY",
        totalAmount: "118000",
      },
    };
    const motherInvoice: CaseDoc = {
      ...invoice,
      id: "mother-invoice",
      sourceFileName: "mother-bill-packet.pdf",
      fields: {
        invoiceNumber: "MFG-900",
        vendorName: "Manufacturer Two",
        supplierGstin: "37AAACT2803M1ZA",
        buyerName: "Distributor One",
        buyerGstin: "27CCCCC0000C1Z5",
        totalAmount: "110000",
      },
    };

    const { groups, mismatches } = verifyGroupedCaseDocuments([
      motherInvoice,
      downstreamInvoice,
    ]);

    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].roleSelection?.primaryDocumentIds, [
      "downstream-invoice",
    ]);
    assert.deepEqual(groups[0].roleSelection?.contextDocumentIds, [
      "mother-invoice",
    ]);
    assert.match(groups[0].roleSelection?.note ?? "", /mother.bill/i);
    assert.ok(
      !mismatches.some(
        (entry) =>
          entry.field === "supplierGstin" || entry.field === "buyerGstin",
      ),
    );

    const summaryDocuments = selectCaseSummaryDocuments(
      [motherInvoice, downstreamInvoice],
      groups,
    );
    const summary = summarizeCase(summaryDocuments, mismatches);
    assert.deepEqual(
      summaryDocuments.map((document) => document.id),
      ["downstream-invoice"],
    );
    assert.equal(summary.invoiceNumber, "DIST-101");
    assert.equal(summary.buyerName, "Distributor One");
    assert.equal(summary.displayName, "Distributor One / DIST-101");
  } finally {
    if (previousInternalNames === undefined) {
      delete process.env.INTERNAL_COMPANY_NAMES;
    } else {
      process.env.INTERNAL_COMPANY_NAMES = previousInternalNames;
    }
  }
});

test("a weighbridge header is not treated as the shipment vendor", () => {
  const lorryReceipt: CaseDoc = {
    id: "lr",
    type: "Lorry Receipt",
    title: "Lorry Receipt",
    pages: 1,
    fields: { vendorName: "TATA STARL LIMITED" },
    md: "Consignor: TATA STEEL LIMITED",
  };
  const weighment: CaseDoc = {
    id: "weighment",
    type: "Weighment Slip",
    title: "Weighment Slip",
    pages: 1,
    fields: { vendorName: "BEEKAY STEEL INDUSTRIES LIMITED" },
    md: "BEEKAY STEEL INDUSTRIES LIMITED\nCUSTOMER: TATA",
  };
  const printedLorryReceipt: CaseDoc = {
    ...lorryReceipt,
    id: "printed-lr",
    fields: { vendorName: "TATA STEEL LIMITED" },
  };

  assert.ok(
    !verifyCaseDocuments([lorryReceipt, weighment, printedLorryReceipt]).some(
      (mismatch) => mismatch.field === "vendorName",
    ),
  );
});
