import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyInvoiceCommercialFieldFallback,
  extractInvoiceCommercialFieldsFromText,
} from "../src/server/invoice-commercial-fields";
import { applyInvoicePoReferenceFallback } from "../src/server/invoice-po-reference";
import type { CaseDoc } from "../src/types/pipeline";

const invoiceText = `TAX INVOICE ARM/26-27/101
INVOICE DATE 31-Aug-2026
REFERENCE PO NUMBER
SG/PO/26-27/101
Packing and freight included.
No additional charges.
Currency: INR.
Taxable value 620,000.00
CGST @ 9% 55,800.00
SGST @ 9% 55,800.00
Invoice total (INR) 731,600.00
Price: fixed per KG; packing and freight included. GST: CGST 9% + SGST 9%.`;

test("included freight does not inherit nearby subtotal or goods tax, even in flattened PDF text", () => {
  for (const source of [invoiceText, invoiceText.replace(/\n/g, " ")]) {
    const recovered = extractInvoiceCommercialFieldsFromText(source);
    assert.equal(recovered.freightAmount, "");
    assert.equal(recovered.freightGstRate, "");
    const fields = applyInvoiceCommercialFieldFallback(
      { totalAmount: "731600" },
      "Tax Invoice",
      source,
    );
    assert.equal(fields.freightAmount, undefined);
    assert.equal(fields.freightGstRate, undefined);
    assert.equal(fields.totalAmount, "731600");
  }
});

test("explicit freight charges and their rates remain recoverable", () => {
  const fixtures = [
    ["Freight Amount: INR 1,200.00 GST @ 18%", "1200.00", "18"],
    ["Transportation Inward @ 5% INR 1,000.00", "1000.00", "5"],
    ["Transport charges (INR): 500.00", "500.00", ""],
    ["Freight amount\n1,200.00\nInvoice total: 15000.00", "1200.00", ""],
    ["Freight GST Rate: 18%", "", "18"],
    ["Freight: 500.00 CGST @ 9% SGST @ 9%", "500.00", ""],
    ["Freight included. Subtotal INR 620000.00 GST 18%", "", ""],
    ["Freight TDS Amount INR 500.00", "", ""],
  ];
  for (const [source, amount, rate] of fixtures) {
    const fields = extractInvoiceCommercialFieldsFromText(source);
    assert.equal(fields.freightAmount, amount, source);
    assert.equal(fields.freightGstRate, rate, source);
  }
});

test("invoice PO references use explicit labels instead of the supplier's invoice number format", () => {
  for (const source of [invoiceText, invoiceText.replace(/\n/g, " ")]) {
    for (const referencePoNumber of [
      undefined,
      "SG/PO/26-27/101",
      "ARM/26-27/101",
    ]) {
      const recovered = applyInvoicePoReferenceFallback(
        { invoiceNumber: "ARM/26-27/101", referencePoNumber },
        "Tax Invoice",
        source,
      );
      assert.equal(recovered.referencePoNumber, "SG/PO/26-27/101");
    }
  }
  for (const [label, expected] of [
    ["PO No: PO-002", "PO-002"],
    ["P.O. No. | RM/25-26/PR25Y-00001", "RM/25-26/PR25Y-00001"],
    ["Buyer's Order No: ABC-345", "ABC-345"],
    ["PO No.\n: EMAIL-TG Regular\nDate: 05.08.2026", "EMAIL-TG Regular"],
  ]) {
    assert.equal(
      applyInvoicePoReferenceFallback({}, "Invoice", label).referencePoNumber,
      expected,
    );
  }
});

test("unlabelled invoice, indent, date, and ambiguous PO references do not invent a PO", () => {
  for (const source of [
    "Invoice No: ARM/26-27/101",
    "Indent No: IND-001",
    "PO Date: 31-08-2026",
    "PO No: PO-001 and PO No: PO-002",
  ]) {
    assert.equal(
      applyInvoicePoReferenceFallback(
        { invoiceNumber: "ARM/26-27/101" },
        "Invoice",
        source,
      ).referencePoNumber,
      undefined,
      source,
    );
  }
  const current = {
    invoiceNumber: "ARM/26-27/101",
    referencePoNumber: "EXISTING-PO-001",
  };
  assert.deepEqual(
    applyInvoicePoReferenceFallback(current, "Invoice", invoiceText),
    current,
  );
  assert.deepEqual(
    applyInvoicePoReferenceFallback({}, "Lorry Receipt", invoiceText),
    {},
  );
});

test("a delivery-order number is removed when the PO row contains only a dispatch instruction", () => {
  const fields = applyInvoicePoReferenceFallback(
    {
      invoiceNumber: "4725014558",
      referencePoNumber: "9520040718",
    },
    "Invoice",
    "GST Invoice No: 4725014558 DO No: 9520040718 Date: 14.08.2026 PO No: Hyderabad DO Prepaid Date: 13.08.2026 Delivery No: 911610050",
  );

  assert.equal(fields.referencePoNumber, undefined);
});

test("AI review cannot inject unsupported fields or erase a visible commercial table", async (t) => {
  const previous = process.env.OPENROUTER_API_KEY;
  const reviewSetting = process.env.PACKET_EXTRACTION_REVIEW_ENABLED;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  process.env.PACKET_EXTRACTION_REVIEW_ENABLED = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    if (reviewSetting === undefined)
      delete process.env.PACKET_EXTRACTION_REVIEW_ENABLED;
    else process.env.PACKET_EXTRACTION_REVIEW_ENABLED = reviewSetting;
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict: "corrected",
              corrections: [
                {
                  docId: "invoice",
                  fields: { referencePoNumber: "PO-001" },
                  lineItems: [],
                  reason: "Correct PO reference only",
                },
              ],
              reviewIssues: [],
            }),
          },
        },
      ],
    });
  });
  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const doc: CaseDoc = {
    id: "invoice",
    type: "Tax Invoice",
    title: "Invoice",
    pages: 1,
    fields: { invoiceNumber: "INV-001", subtotal: "620000" },
    lineItems: [
      {
        itemCode: "PL06",
        description: "MS Plate 6 mm, Grade E250",
        hsnSac: "7208",
        quantity: "8000",
        unit: "KG",
        rate: "50",
        taxableAmount: "400000",
      },
    ],
    md: "## Visible Text\nITEM / DESCRIPTION | HSN | QTY | RATE | TAXABLE\nPL06 - MS Plate 6 mm, Grade E250 | 7208 | 8000 | 50 | 400000",
  };
  const result = await reviewAndCorrectExtractedDocuments([doc], {
    candidateDocumentIds: [doc.id],
  });
  assert.equal(calls, 1);
  assert.equal(result.documents[0].fields.referencePoNumber, undefined);
  assert.deepEqual(result.documents[0].lineItems, doc.lineItems);
  assert.ok(
    result.review.warnings.some((warning) =>
      warning.includes("empty line-item replacement"),
    ),
  );
  assert.ok(
    result.review.warnings.some((warning) =>
      warning.includes("unsupported field correction"),
    ),
  );
  assert.equal(doc.fields.referencePoNumber, undefined);
});

test("review accepts date corrections but cannot regress source-supported weights", async (t) => {
  const previous = process.env.OPENROUTER_API_KEY;
  const reviewSetting = process.env.PACKET_EXTRACTION_REVIEW_ENABLED;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  process.env.PACKET_EXTRACTION_REVIEW_ENABLED = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    if (reviewSetting === undefined)
      delete process.env.PACKET_EXTRACTION_REVIEW_ENABLED;
    else process.env.PACKET_EXTRACTION_REVIEW_ENABLED = reviewSetting;
  });

  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict: "corrected",
              corrections: [
                {
                  docId: "weighment",
                  fields: {
                    grossWeight: "5701 kg",
                    tareWeight: "1670 kg",
                    netWeight: "4031 kg",
                  },
                  reason: "Visual review",
                },
                {
                  docId: "eway",
                  fields: {
                    documentDate: "2026-08-14",
                    validityDate: "2026-08-18",
                  },
                  reason: "Use the explicitly labelled dates",
                },
              ],
              reviewIssues: [],
            }),
          },
        },
      ],
    }),
  );
  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const weighment: CaseDoc = {
    id: "weighment",
    type: "Weighment Slip",
    title: "Weighment",
    pages: 1,
    fields: {
      grossWeight: "57010 kg",
      tareWeight: "16700 kg",
      netWeight: "40310 kg",
    },
    md: "## Visible Text\nGROSS 57010 kg\nTARE 16700 kg\nNET 40310 kg\nFOUR ZERO THREE ONE ZERO kg",
  };
  const eway: CaseDoc = {
    id: "eway",
    type: "E-Way Bill",
    title: "E-Way Bill",
    pages: 1,
    fields: {
      documentDate: "14/08/2026 09:33 PM",
      validityDate: "14/08/2026 09:33 PM",
    },
    md: "## Visible Text\nE-Way Bill Date: 14/08/2026 09:33 PM\nValid Until: 18/08/2026",
  };

  const result = await reviewAndCorrectExtractedDocuments([weighment, eway], {
    candidateDocumentIds: [weighment.id, eway.id],
  });

  assert.deepEqual(result.documents[0].fields, weighment.fields);
  assert.equal(result.documents[1].fields.documentDate, "2026-08-14");
  assert.equal(result.documents[1].fields.validityDate, "2026-08-18");
  assert.ok(
    result.review.warnings.some((warning) =>
      warning.includes("unsupported field correction"),
    ),
  );
});

test("review accepts a short tax-rate correction when the labelled rate is visible", async (t) => {
  const previous = process.env.OPENROUTER_API_KEY;
  const reviewSetting = process.env.PACKET_EXTRACTION_REVIEW_ENABLED;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  process.env.PACKET_EXTRACTION_REVIEW_ENABLED = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    if (reviewSetting === undefined)
      delete process.env.PACKET_EXTRACTION_REVIEW_ENABLED;
    else process.env.PACKET_EXTRACTION_REVIEW_ENABLED = reviewSetting;
  });

  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              verdict: "corrected",
              corrections: [
                {
                  docId: "upstream-tax-review",
                  fields: { igstRate: "18", cgstRate: null, sgstRate: null },
                  reason: "The invoice explicitly prints IGST at 18%.",
                },
              ],
              reviewIssues: [],
            }),
          },
        },
      ],
    }),
  );
  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const result = await reviewAndCorrectExtractedDocuments(
    [
      {
        id: "upstream-tax-review",
        type: "Tax Invoice",
        title: "Upstream invoice",
        pages: 1,
        fields: { taxRate: "18", cgstRate: "9", sgstRate: "9" },
        md: "## Visible Text\nIGST at 18% 327,600.00",
      },
    ],
    { candidateDocumentIds: ["upstream-tax-review"] },
  );

  assert.equal(result.documents[0].fields.igstRate, "18");
  assert.equal(result.documents[0].fields.cgstRate, undefined);
  assert.equal(result.documents[0].fields.sgstRate, undefined);
  assert.equal(result.review.warnings.length, 0);
});

test("visible E-Way evidence restores the full IRN and prefers Valid Until", async () => {
  const { enrichProcessedDocuments } =
    await import("../src/server/processing/pipeline");
  const irn =
    "beb5e533673db1d8dc1fc1dd801d882714c314e0b18e895d160e47395fc43f98";
  const [eway] = enrichProcessedDocuments([
    {
      id: "eway",
      type: "E-Way Bill",
      title: "E-Way Bill",
      pages: 1,
      fields: {
        irnNumber: irn.slice(0, 53),
        validityDate: "14/08/2026 09:33 PM",
      },
      md: `## Visible Text\nIRN:\n${irn.slice(0, 52)}\n${irn.slice(52)}\nValid From: 14/08/2026 09:33 PM\nValid Until: 18/08/2026`,
    },
  ]);

  assert.equal(eway.fields.irnNumber, irn);
  assert.equal(eway.fields.validityDate, "18/08/2026");
});

test("multi-column OCR restores a wrapped invoice IRN across intervening address text", async () => {
  const { enrichProcessedDocuments } =
    await import("../src/server/processing/pipeline");
  const irn =
    "48c362f7275ba125156bf869bd8ff7cefe627daf1ceeea421c0f1468086f56e6";
  const [invoice] = enrichProcessedDocuments([
    {
      id: "invoice-wrapped-irn",
      type: "Tax Invoice",
      title: "Tax Invoice",
      pages: 1,
      fields: { irnNumber: irn.slice(0, 56) },
      md:
        `## Visible Text\nIRN:\nName\n: Example Buyer\n${irn.slice(0, 56)}\n` +
        `Address 1\n: Example Road 500034\n${irn.slice(56)}\nGOODS REMOVAL DETAILS`,
    },
  ]);

  assert.equal(invoice.fields.irnNumber, irn);
});

test("a complete image-extracted IRN is not overwritten by a conflicting OCR transcription", async () => {
  const { enrichProcessedDocuments } =
    await import("../src/server/processing/pipeline");
  const imageIrn =
    "b758281f7e443abfbec49567da2987a825981f366e2cb893a572eba9a63fdc9b";
  const ocrIrn = `6${imageIrn.slice(1)}`;
  const [eway] = enrichProcessedDocuments([
    {
      id: "eway-valid-irn",
      type: "E-Way Bill",
      title: "E-Way Bill",
      pages: 1,
      fields: { irnNumber: imageIrn },
      md: `## Visible Text\nIRN ${ocrIrn}`,
    },
  ]);

  assert.equal(eway.fields.irnNumber, imageIrn);
});

test("invoice and lorry evidence recover cross-document logistics fields", async () => {
  const { enrichProcessedDocuments } =
    await import("../src/server/processing/pipeline");
  const [invoice, lorry, eway] = enrichProcessedDocuments([
    {
      id: "invoice-logistics",
      type: "Tax Invoice",
      title: "Tax Invoice",
      pages: 1,
      fields: {
        invoiceNumber: "INV-501",
        taxAmount: "295986.05",
        totalAmount: "1940353",
      },
      lineItems: [
        {
          quantity: "30.710",
          unit: "MT",
          rate: "53545",
          taxableAmount: "1644366.95",
        },
      ],
      md: "## Visible Text\nLR/RR No.: ZB1741032154\nTare Weight: 16.100 (TO) Gross Weight: 46.810 (TO) Net Weight: 30.710 (ΤΟ)",
    },
    {
      id: "lorry-logistics",
      type: "Lorry Receipt",
      title: "Lorry Receipt",
      pages: 1,
      fields: { netWeight: "30.710" },
      md: "## Visible Text\nGST Inv. No.\nINV-501\nGST Inv. Value\n1,940,353.00\nDespatched Quantity (MT)\nNet Wt.\n30.710",
    },
    {
      id: "eway-transporter",
      type: "E-Way Bill",
      title: "E-Way Bill",
      pages: 1,
      fields: { transporterName: "INLAND TEEVRA PRIVATE LIMITED 5" },
      md: "## Visible Text\n4. Transportation Details\nTransporter ID & Name: 88AAECI8919H1ZM & INLAND TEEVRA PRIVATE LIMITED\n5. Vehicle Details",
    },
  ]);

  assert.equal(invoice.fields.lorryReceiptNumber, "ZB1741032154");
  assert.equal(invoice.fields.grossWeight, "46.81 MT");
  assert.equal(invoice.fields.tareWeight, "16.1 MT");
  assert.equal(invoice.fields.netWeight, "30.71 MT");
  assert.equal(invoice.fields.subtotal, "1644366.95");
  assert.equal(lorry.fields.referenceInvoiceNumber, "INV-501");
  assert.equal(lorry.fields.totalAmount, "1940353.00");
  assert.equal(lorry.fields.netWeight, "30.71 MT");
  assert.equal(eway.fields.transporterName, "INLAND TEEVRA PRIVATE LIMITED");
});

test("linked packet consensus restores review omissions without overriding conflicts", async () => {
  const { enrichProcessedDocuments } =
    await import("../src/server/processing/pipeline");
  const irn =
    "9dd92a89dbe18ebadc4a43c23742d1bad7462f85e464a33ecedc9a2e8888ec68";
  const [invoice, eway, lorry] = enrichProcessedDocuments([
    {
      id: "packet-invoice",
      type: "Tax Invoice",
      title: "Tax Invoice",
      pages: 1,
      fields: {
        invoiceNumber: "9414016924",
        irnNumber: irn,
        eWayBillNumber: "421758716256",
        vehicleNumber: "NL01AJ8495",
        vendorName: "TATA STEEL LIMITED",
        buyerName: "SAMRAT IRONS PRIVATE LIMITED",
        buyerGstin: "36AAQCS9189P1ZY",
        supplierGstin: "20AAACT2803M2ZO",
      },
      md: "## Visible Text\nInvoice No. 9414016924\nE-Way Bill 421758716256\nVehicle NL01AJ8495",
    },
    {
      id: "packet-eway",
      type: "E-Way Bill",
      title: "E-Way Bill",
      pages: 1,
      fields: {
        referenceInvoiceNumber: "9414016924",
        eWayBillNumber: "421758716256",
        lorryReceiptNumber: "ZB1741032139",
        vehicleNumber: "NL01AJ8495",
        transporterName: "INLAND TEEVRA",
        vendorName: "TATA STEEL LIMITED",
        buyerName: "SAMRAT IRONS PRIVATE LIMITED",
        buyerGstin: "36AAQCS9189P1ZY",
        supplierGstin: "20AAACT2803M2ZO",
      },
      md: "## Visible Text\nDoc No. 9414016924\nTransporter Doc. No. ZB1741032139\nVehicle NL01AJ8495",
    },
    {
      id: "packet-lorry",
      type: "Lorry Receipt",
      title: "Lorry Receipt",
      pages: 1,
      fields: {
        referenceInvoiceNumber: "9414016924",
        lorryReceiptNumber: "ZB1741032139",
        vehicleNumber: "NL01AJ8495",
        transporterName: "INLAND TEEVRA PRIVATE LIMITED",
        vendorName: "TATA STREL LIMITED",
        buyerName: "SAMRAT IRONS PRIVATE LIMITED",
        buyerGstin: "36AAQCS9189P1ZY",
        supplierGstin: "20AAACT2803M2ZO",
      },
      md: "## Visible Text\nConsignee: SAMRAT IRONS PRIVATE LIMITED\nGSTIN: 36AAQCS9189P1ZY\nInvoice No. 9414016924\nConsignment Note ZB1741032139\nVehicle NL01AJ8495",
    },
  ] satisfies CaseDoc[]);

  assert.equal(invoice.fields.lorryReceiptNumber, "ZB1741032139");
  assert.equal(eway.fields.irnNumber, irn);
  assert.equal(eway.fields.transporterName, "INLAND TEEVRA PRIVATE LIMITED");
  assert.equal(lorry.fields.buyerGstin, "36AAQCS9189P1ZY");
  assert.equal(lorry.fields.buyerName, "SAMRAT IRONS PRIVATE LIMITED");
  assert.equal(lorry.fields.vendorName, "TATA STEEL LIMITED");
  assert.equal(lorry.fields.taxRate, undefined);
  assert.equal(lorry.fields.igstRate, undefined);
});

test("a printed LR series and handwritten suffix are preserved as one reference", async () => {
  const { enrichProcessedDocuments } =
    await import("../src/server/processing/pipeline");
  const [lorry] = enrichProcessedDocuments([
    {
      id: "split-lr-reference",
      type: "Lorry Receipt",
      title: "Goods Consignment Note",
      pages: 1,
      fields: { lorryReceiptNumber: "10433" },
      md: "## Visible Text\nLR No. 26 JK\n10433\nDate: 14/08/2026\nInvoice No. 4725014558",
    },
  ] satisfies CaseDoc[]);

  assert.equal(lorry.fields.lorryReceiptNumber, "26JK10433");
  assert.match(lorry.md, /\*\*Lorry Receipt Number\*\*: 26JK10433/);
  assert.doesNotMatch(lorry.md, /\*\*Lorry Receipt Number\*\*: 10433(?:\s|$)/);
});

test("a flattened LR page does not append the next LR label to the reference", async () => {
  const { enrichProcessedDocuments } =
    await import("../src/server/processing/pipeline");
  const [lorry] = enrichProcessedDocuments([
    {
      id: "flattened-lr-reference",
      type: "Lorry Receipt",
      title: "Lorry Receipt",
      pages: 1,
      fields: { lorryReceiptNumber: "LR-TS09QA2046LR" },
      md: "## Visible Text\nLORRY RECEIPT LR NUMBER LR-TS09QA2046 LR DATE 07-09-2026 VEHICLE TS09QA2046",
    },
  ] satisfies CaseDoc[]);

  assert.equal(lorry.fields.lorryReceiptNumber, "LR-TS09QA2046");
  assert.match(lorry.md, /\*\*Lorry Receipt Number\*\*: LR-TS09QA2046/);
  assert.doesNotMatch(lorry.md, /LR-TS09QA2046LR/);
});

test("role-labelled GSTIN evidence survives packet consensus and drives IGST", async () => {
  const { enrichProcessedDocuments } =
    await import("../src/server/processing/pipeline");
  const documents: CaseDoc[] = [
    {
      id: "upstream-invoice",
      type: "Tax Invoice",
      title: "Upstream invoice",
      pages: 1,
      fields: {
        supplierGstin: "36BRIDG0000B1ZH",
        buyerGstin: "36BRIDG0000B1ZH",
        taxRate: "18",
        cgstRate: "9",
        sgstRate: "9",
        subtotal: "1820000",
        taxAmount: "327600",
        totalAmount: "2147600",
      },
      lineItems: [
        {
          quantity: "40",
          unit: "MT",
          taxableAmount: "1820000",
          taxRate: "18",
          cgstRate: "9",
          sgstRate: "9",
        },
      ],
      md: "## Visible Text\nSupplier GSTIN: 37TESTS0000T1Z4 Buyer GSTIN: 36BRIDG0000B1ZH IGST at 18% 327,600.00",
    },
    {
      id: "buyer-facing-invoice",
      type: "Tax Invoice",
      title: "Buyer-facing invoice",
      pages: 1,
      fields: {
        supplierGstin: "36BRIDG0000B1ZH",
        buyerGstin: "36SAMRA0000S1Z5",
      },
      md: "## Visible Text\nSupplier GSTIN: 36BRIDG0000B1ZH Buyer GSTIN: 36SAMRA0000S1Z5",
    },
    {
      id: "eway",
      type: "E-Way Bill",
      title: "E-Way Bill",
      pages: 1,
      fields: {
        supplierGstin: "36BRIDG0000B1ZH",
        buyerGstin: "36SAMRA0000S1Z5",
      },
      md: "## Visible Text\nSupplier GSTIN: 36BRIDG0000B1ZH Buyer GSTIN: 36SAMRA0000S1Z5",
    },
  ];

  const [upstream] = enrichProcessedDocuments(
    enrichProcessedDocuments(documents),
  );
  assert.equal(upstream.fields.supplierGstin, "37TESTS0000T1Z4");
  assert.equal(upstream.fields.buyerGstin, "36BRIDG0000B1ZH");
  assert.equal(upstream.fields.taxRate, "18");
  assert.equal(upstream.fields.igstRate, "18");
  assert.equal(upstream.fields.cgstRate, undefined);
  assert.equal(upstream.fields.sgstRate, undefined);
  assert.equal(upstream.lineItems?.[0].igstRate, "18");
  assert.equal(upstream.lineItems?.[0].cgstRate, undefined);
  assert.equal(upstream.lineItems?.[0].sgstRate, undefined);
});

test("an explicitly required missing attachment becomes actionable", async (t) => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  });
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              obligations: [
                {
                  sourceDocId: "po-required-documents",
                  sourceClause:
                    "Material Test Certificate must accompany each vehicle.",
                  obligation: "Include the material test certificate.",
                  category: "Document requirement",
                  status: "unknown",
                  evidenceDocIds: [],
                  evidence: "",
                  reason: "Could not determine whether it was uploaded.",
                  severity: "medium",
                },
                {
                  sourceDocId: "po-required-documents",
                  sourceClause: "E-Way Bill is required if applicable.",
                  obligation: "Include an E-Way Bill when applicable.",
                  category: "Document requirement",
                  status: "unknown",
                  evidenceDocIds: [],
                  evidence: "",
                  reason: "Applicability is unclear.",
                  severity: "medium",
                },
              ],
            }),
          },
        },
      ],
    }),
  );
  const { assessCaseTermsComplianceDetailed } =
    await import("../src/server/processing/pipeline");
  const result = await assessCaseTermsComplianceDetailed([
    {
      id: "po-required-documents",
      type: "Purchase Order",
      title: "Purchase Order",
      pages: 1,
      fields: {
        termsAndConditions:
          "Material Test Certificate must accompany each vehicle. E-Way Bill is required if applicable.",
      },
      md: "## Visible Text\nSPECIAL TERMS: Material Test Certificate must accompany each vehicle. E-Way Bill is required if applicable.",
    },
  ] satisfies CaseDoc[]);

  assert.equal(result.checklist[0].status, "not_fulfilled");
  assert.match(result.checklist[0].reason, /packet does not contain one/i);
  assert.equal(result.checklist[1].status, "unknown");
  assert.equal(result.mismatches.length, 1);
  assert.match(result.mismatches[0].analysis ?? "", /not fulfilled/i);
});

test("required-document checks survive a failed model request", async (t) => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("simulated model outage");
  });
  const { assessCaseTermsComplianceDetailed } =
    await import("../src/server/processing/pipeline");
  const result = await assessCaseTermsComplianceDetailed([
    {
      id: "po-model-omission",
      type: "Purchase Order",
      title: "Purchase Order",
      pages: 1,
      fields: {
        termsAndConditions:
          "Material Test Certificate must accompany each vehicle; E-Way Bill is required if applicable.",
      },
      md: "## Visible Text\nMaterial Test Certificate must accompany each vehicle. E-Way Bill is required if applicable.",
    },
  ] satisfies CaseDoc[]);

  assert.equal(result.checklist.length, 1);
  assert.equal(result.checklist[0].status, "not_fulfilled");
  assert.match(result.checklist[0].sourceClause, /Material Test Certificate/i);
  assert.equal(result.mismatches.length, 1);
});

test("GSTIN geography does not invent an unsupported E-Way Bill tax rate", async () => {
  const { enrichProcessedDocuments } =
    await import("../src/server/processing/pipeline");
  const [eway] = enrichProcessedDocuments([
    {
      id: "eway-no-visible-tax-rate",
      type: "E-Way Bill",
      title: "E-Way Bill",
      pages: 1,
      fields: {
        eWayBillNumber: "112518907981",
        supplierGstin: "37AAACT2803M1ZA",
        buyerGstin: "36AAQCS9189P1ZY",
        totalAmount: "2655931.58",
      },
      md: "## Visible Text\nValue of Goods\n2655931.58",
    },
  ] satisfies CaseDoc[]);

  assert.equal(eway.fields.taxRate, undefined);
  assert.equal(eway.fields.igstRate, undefined);
  assert.doesNotMatch(eway.md, /GST Rate|IGST Rate/);
});

test("E-Way Bill Value of Goods is kept as invoice total, not taxable subtotal", async () => {
  const { enrichProcessedDocuments } =
    await import("../src/server/processing/pipeline");
  const [eway] = enrichProcessedDocuments([
    {
      id: "eway-value-of-goods",
      type: "E-Way Bill",
      title: "E-Way Bill",
      pages: 1,
      fields: {
        totalTaxableAmount: "2655931.58",
        subtotal: "2655931.58",
      },
      md: "## Visible Text\nValue of Goods\n2655931.58",
    },
  ] satisfies CaseDoc[]);

  assert.equal(eway.fields.totalAmount, "2655931.58");
  assert.equal(eway.fields.totalTaxableAmount, undefined);
  assert.equal(eway.fields.subtotal, undefined);
});

test("invoice material value stays on its goods line when freight is separate", async () => {
  const { enrichProcessedDocuments } =
    await import("../src/server/processing/pipeline");
  const [invoice] = enrichProcessedDocuments([
    {
      id: "invoice-material-and-freight",
      type: "Invoice",
      title: "Invoice",
      pages: 1,
      fields: {
        invoiceNumber: "INV-701",
        subtotal: "2250789.47",
        freightAmount: "84167.27",
        taxAmount: "405142.11",
        totalAmount: "2655931.58",
        supplierGstin: "37AAACT2803M1ZA",
        buyerGstin: "36AAQCS9189P1ZY",
      },
      lineItems: [
        {
          quantity: "40.31",
          unit: "MT",
          taxableAmount: "2250789.47",
          taxAmount: "405142.11",
          igstAmount: "405142.11",
        },
      ],
      md: "## Visible Text\nParticulars Rate (Rs./TO) Total (Rs.) MATERIAL VALUE 53,749,00 2,166,622.20 LESS DISCOUNT 0.00 FREIGHT VALUE 84,167.27 TAXABLE VALUE 2,250,789.47 IGST @ 18.00% 405,142.11",
    },
  ] satisfies CaseDoc[]);

  assert.equal(invoice.lineItems?.[0].rate, "53749");
  assert.equal(invoice.lineItems?.[0].taxableAmount, "2166622.2");
  assert.equal(invoice.lineItems?.[0].lineTotal, "2166622.2");
  assert.equal(invoice.lineItems?.[0].taxAmount, undefined);
  assert.equal(invoice.lineItems?.[0].igstAmount, undefined);
  assert.equal(invoice.fields.subtotal, "2250789.47");
  assert.equal(invoice.fields.freightAmount, "84167.27");
  assert.match(invoice.md, /rate 53749/);
  assert.match(invoice.md, /taxable 2166622\.2/);
  assert.doesNotMatch(invoice.md, /taxable 2250789\.47/);
});

test("an LR majority explains a possible secondary carrier reference", async () => {
  const { verifyProcessedDocuments } =
    await import("../src/server/processing/pipeline");
  const result = verifyProcessedDocuments(
    [
      {
        id: "invoice-lr-majority",
        type: "Invoice",
        title: "Invoice",
        pages: 1,
        fields: {
          invoiceNumber: "INV-801",
          lorryReceiptNumber: "P22305621700",
        },
        md: "",
      },
      {
        id: "eway-lr-majority",
        type: "E-Way Bill",
        title: "E-Way Bill",
        pages: 1,
        fields: {
          referenceInvoiceNumber: "INV-801",
          lorryReceiptNumber: "P22305621700",
        },
        md: "",
      },
      {
        id: "carrier-lr-outlier",
        type: "Lorry Receipt",
        title: "Carrier Consignment Note",
        pages: 1,
        fields: {
          referenceInvoiceNumber: "INV-801",
          lorryReceiptNumber: "26JK10433",
        },
        md: "",
      },
    ] satisfies CaseDoc[],
    { considerFormatting: false },
  );
  const mismatch = result.mismatches.find(
    (entry) => entry.field === "lorryReceiptNumber",
  );

  if (!mismatch) assert.fail("Expected an LR mismatch");
  assert.match(mismatch.analysis ?? "", /corroborated by 2 linked documents/);
  assert.match(
    mismatch.analysis ?? "",
    /secondary carrier consignment reference/,
  );
});

test("a line-item arithmetic conflict triggers intelligent second-pass review", async (t) => {
  const previous = process.env.OPENROUTER_API_KEY;
  const reviewSetting = process.env.PACKET_EXTRACTION_REVIEW_ENABLED;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  process.env.PACKET_EXTRACTION_REVIEW_ENABLED = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    if (reviewSetting === undefined)
      delete process.env.PACKET_EXTRACTION_REVIEW_ENABLED;
    else process.env.PACKET_EXTRACTION_REVIEW_ENABLED = reviewSetting;
  });

  let requestBody = "";
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return Response.json({
        choices: [
          {
            message: {
              content: '{"verdict":"pass","corrections":[],"reviewIssues":[]}',
            },
          },
        ],
      });
    },
  );

  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const invoice: CaseDoc = {
    id: "invoice-arithmetic",
    type: "Tax Invoice",
    title: "Tax Invoice",
    pages: 1,
    fields: { invoiceNumber: "INV-601", totalAmount: "1940353" },
    lineItems: [
      {
        quantity: "20",
        unit: "Nos",
        rate: "53545",
        taxableAmount: "1644366.95",
      },
    ],
    md: "## Visible Text\nPieces 20\nQuantity (TO) 30.710\nRate (Rs./TO) 53,545.00\nTaxable value 1,644,366.95",
  };

  const result = await reviewAndCorrectExtractedDocuments([invoice]);
  assert.equal(result.review.enabled, true);
  assert.match(requestBody, /lineItemArithmeticConflict/);
});

test("required review retries one malformed verdict before accepting the packet", async (t) => {
  const previous = process.env.OPENROUTER_API_KEY;
  const reviewSetting = process.env.PACKET_EXTRACTION_REVIEW_ENABLED;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  process.env.PACKET_EXTRACTION_REVIEW_ENABLED = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    if (reviewSetting === undefined)
      delete process.env.PACKET_EXTRACTION_REVIEW_ENABLED;
    else process.env.PACKET_EXTRACTION_REVIEW_ENABLED = reviewSetting;
  });

  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({
      choices: [
        {
          message: {
            content:
              calls === 1
                ? '{"corrections":[]}'
                : '{"verdict":"pass","corrections":[],"reviewIssues":[]}',
          },
        },
      ],
    });
  });

  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const result = await reviewAndCorrectExtractedDocuments([
    {
      id: "review-contract",
      type: "Tax Invoice",
      title: "Tax Invoice",
      pages: 1,
      fields: { invoiceNumber: "INV-901" },
      md: "## Visible Text\nInvoice No INV-901",
    },
  ]);

  assert.equal(calls, 2);
  assert.equal(result.review.required, true);
  assert.equal(result.review.verdict, "pass");
  assert.equal(result.review.attemptCount, 2);
});

test("required review fails closed when both verdict responses are malformed", async (t) => {
  const previous = process.env.OPENROUTER_API_KEY;
  const reviewSetting = process.env.PACKET_EXTRACTION_REVIEW_ENABLED;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  process.env.PACKET_EXTRACTION_REVIEW_ENABLED = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    if (reviewSetting === undefined)
      delete process.env.PACKET_EXTRACTION_REVIEW_ENABLED;
    else process.env.PACKET_EXTRACTION_REVIEW_ENABLED = reviewSetting;
  });

  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({
      choices: [{ message: { content: '{"corrections":[]}' } }],
    });
  });

  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  await assert.rejects(
    reviewAndCorrectExtractedDocuments([
      {
        id: "review-contract-failure",
        type: "Tax Invoice",
        title: "Tax Invoice",
        pages: 1,
        fields: { invoiceNumber: "INV-902" },
        md: "## Visible Text\nInvoice No INV-902",
      },
    ]),
    /Required extraction review failed after 2 attempts/,
  );
  assert.equal(calls, 2);
});

test("a carrier header GSTIN is not promoted to the lorry receipt supplier", async () => {
  const { enrichProcessedDocuments } =
    await import("../src/server/processing/pipeline");
  const [lorry] = enrichProcessedDocuments([
    {
      id: "carrier-lr",
      type: "Lorry Receipt",
      title: "Lorry Receipt",
      pages: 1,
      fields: {
        transporterName: "Jayakumari Logistics Pvt Ltd",
        vendorName: "Tata Steel Limited",
        supplierGstin: "37AADCJ0114E1Z6",
      },
      md: "## Visible Text\nJAYAKUMARI LOGISTICS PVT. LTD.\nPAN No. AADCJ0114E\nGSTIN: 37AADCJ0114E1Z6\nConsignor's Name and Address\nTata Steel Limited",
    },
  ]);

  assert.equal(lorry.fields.supplierGstin, undefined);
  assert.ok(
    lorry.qualityIssues?.some(
      (issue) =>
        issue.field === "supplierGstin" && issue.action === "corrected",
    ),
  );
});

test("structured line-item relocation does not create false quality-review mismatches", async () => {
  const { verifyProcessedDocuments } =
    await import("../src/server/processing/pipeline");
  const documents: CaseDoc[] = [
    {
      id: "structured-invoice",
      type: "Invoice",
      title: "Invoice",
      pages: 1,
      fields: {
        invoiceNumber: "INV-STRUCTURED",
        taxRate: "18",
        netWeight: "40.31 MT",
      },
      lineItems: [
        {
          description: "TMT bar",
          hsnSac: "72142090",
          quantity: "40.310",
          unit: "MT",
          taxRate: "18",
        },
      ],
      qualityIssues: [
        {
          field: "itemQuantity",
          originalValue: "40.31",
          action: "quarantined",
          reason: "Moved the item-specific value to the structured line item.",
        },
        {
          field: "unit",
          originalValue: "TO",
          action: "quarantined",
          reason: "Moved the item-specific value to the structured line item.",
        },
        {
          field: "hsnSac",
          originalValue: "72142090",
          action: "quarantined",
          reason: "Moved the item-specific value to the structured line item.",
        },
        {
          field: "taxRate",
          originalValue: "18",
          action: "quarantined",
          reason: "Moved the item-specific value to the structured line item.",
        },
        {
          field: "netWeight",
          originalValue: "40.31 MT",
          action: "quarantined",
          reason:
            "The document-level value was restored from visible evidence.",
        },
      ],
      md: "## Visible Text\nQuantity 40.310 TO\nHSN 72142090\nGST 18%\nNet Weight 40.31 MT",
    },
    {
      id: "eway-total",
      type: "E-Way Bill",
      title: "E-Way Bill",
      pages: 1,
      fields: { totalAmount: "2655931.58" },
      qualityIssues: [
        {
          field: "totalTaxableAmount",
          originalValue: "2655931.58",
          action: "quarantined",
          reason: "Value of Goods was remapped to total amount.",
        },
        {
          field: "subtotal",
          originalValue: "2655931.58",
          action: "quarantined",
          reason: "Value of Goods was remapped to total amount.",
        },
      ],
      md: "## Visible Text\nValue of Goods 2655931.58",
    },
  ];

  const result = verifyProcessedDocuments(documents, {
    considerFormatting: false,
  });
  assert.ok(
    !result.mismatches.some((entry) => entry.id.startsWith("quality-review-")),
  );
});

test("quarantined source evidence becomes an actionable review item instead of disappearing", async () => {
  const { verifyProcessedDocuments } =
    await import("../src/server/processing/pipeline");
  const documents: CaseDoc[] = [
    {
      id: "invoice-evidence",
      type: "Tax Invoice",
      title: "Tax Invoice",
      pages: 1,
      fields: { eWayBillNumber: "123456789012" },
      md: "## Visible Text\nE-Way Bill No 123456789012",
    },
    {
      id: "transport-evidence",
      type: "Lorry Receipt",
      title: "Lorry Receipt",
      pages: 1,
      fields: {},
      qualityIssues: [
        {
          field: "eWayBillNumber",
          originalValue: "23456789012",
          action: "quarantined",
          reason: "The visible source value has only 11 digits.",
        },
      ],
      md: "## Visible Text\nE-Way Bill No 23456789012",
    },
  ];

  const result = verifyProcessedDocuments(documents, {
    considerFormatting: false,
  });
  const issue = result.mismatches.find(
    (entry) =>
      entry.id.startsWith("quality-review-") &&
      entry.field === "eWayBillNumber",
  );
  assert.ok(issue);
  assert.deepEqual(
    issue.values.map((entry) => entry.value),
    ["23456789012", "123456789012"],
  );
  assert.match(issue.analysis ?? "", /preserved|must be checked/i);
});

test("packet-wide AI review applies supported omissions and rejects invented review evidence", async (t) => {
  const previous = process.env.OPENROUTER_API_KEY;
  const reviewSetting = process.env.PACKET_EXTRACTION_REVIEW_ENABLED;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  process.env.PACKET_EXTRACTION_REVIEW_ENABLED = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    if (reviewSetting === undefined)
      delete process.env.PACKET_EXTRACTION_REVIEW_ENABLED;
    else process.env.PACKET_EXTRACTION_REVIEW_ENABLED = reviewSetting;
  });

  let requestBody = "";
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: "needs_review",
                corrections: [
                  {
                    docId: "invoice-complete",
                    fields: { deliveryNoteNumber: "DN-77" },
                    reason: "Explicitly labelled Delivery No",
                  },
                ],
                reviewIssues: [
                  {
                    field: "eWayBillNumber",
                    evidence: [
                      { docId: "transport-complete", value: "23456789012" },
                    ],
                    reason:
                      "Visible number is incomplete and conflicts with the packet.",
                  },
                  {
                    field: "invoiceNumber",
                    evidence: [
                      { docId: "transport-complete", value: "INVENTED-999" },
                    ],
                    reason: "Unsupported value",
                  },
                ],
              }),
            },
          },
        ],
      });
    },
  );

  const { reviewAndCorrectExtractedDocuments } =
    await import("../src/server/processing/pipeline");
  const result = await reviewAndCorrectExtractedDocuments([
    {
      id: "invoice-complete",
      type: "Tax Invoice",
      title: "Tax Invoice",
      pages: 1,
      fields: { invoiceNumber: "INV-77" },
      md: "## Visible Text\nInvoice No INV-77\nDelivery No DN-77",
    },
    {
      id: "transport-complete",
      type: "Lorry Receipt",
      title: "Lorry Receipt",
      pages: 1,
      fields: {},
      qualityIssues: [
        {
          field: "eWayBillNumber",
          originalValue: "23456789012",
          action: "quarantined",
          reason: "The visible source value has only 11 digits.",
        },
      ],
      md: "## Visible Text\nE-Way Bill No 23456789012",
    },
  ]);

  assert.match(requestBody, /invoice-complete/);
  assert.match(requestBody, /transport-complete/);
  assert.match(requestBody, /deliveryNoteNumber/);
  assert.match(requestBody, /deliveryOrderNumber/);
  assert.equal(result.documents[0].fields.deliveryNoteNumber, "DN-77");
  assert.equal(result.reviewIssues.length, 1);
  assert.equal(result.reviewIssues[0].field, "eWayBillNumber");
  assert.equal(result.review.reviewIssueCount, 1);
});
