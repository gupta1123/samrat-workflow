import { createHash } from "node:crypto";
import { pdfTextPages, renderPdfPages } from "./pdf-renderer";
import { compactReviewProviderSchema } from "./review-response-schema";
import { ReviewContractError } from "./review-contract-error";
import { readReferenceLedger, REFERENCE_FIELD_KEYS } from "./reference-ledger";
import {
  orientPageImageWithVision,
  type PageOrientationView,
} from "./page-orientation";
import {
  assertCounterpartySource,
  assertReferenceGrounding,
  COUNTERPARTY_SOURCE_FIELDS,
  REFERENCE_FIELD_DEFINITIONS,
  type CounterpartySource,
  type ReferenceGrounding,
} from "./semantic-grounding";

import sharp from "sharp";

import { summarizeCase } from "@/server/case-summary";
import {
  areComparableValuesEqual,
  DEFAULT_COMPARISON_OPTIONS,
  getComparableFieldValue,
  normalizeComparableValue,
  readComparisonOptions,
} from "@/server/comparison";
import {
  FIELD_DEFINITIONS,
  FIELD_LABELS,
  getFieldKeysForDocType,
  omitIgnoredFields,
  sanitizeFieldsForDocType,
} from "@/server/document-schema";
import {
  buildDocumentReadabilityMismatches,
  parseDocumentPageQuality,
  type DocumentPageQualityAssessment,
} from "@/server/document-readability";
import { EXTRACTION_VERIFICATION_FIELD } from "@/lib/extraction-verification";
import { WEIGHT_CALCULATION_FIELD } from "@/lib/weight-calculation";
import { getPersistedPacketFieldConfiguration } from "@/server/field-settings-service";
import { applyInvoiceCommercialFieldFallback } from "@/server/invoice-commercial-fields";
import { applyInvoicePoReferenceFallback } from "@/server/invoice-po-reference";
import {
  enrichDocumentsWithPacketGstTaxContext,
  isCommercialDocType,
  normalizeExtractedCommercialLineItems,
  sanitizeLineItems,
} from "@/server/line-items";
import {
  verifyGroupedCaseDocuments,
  verifyWeightCalculationInvariants,
  type VerificationGroup,
} from "@/server/services/verification";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import {
  isActionableTermsComplianceStatus,
  TERMS_COMPLIANCE_FIELD,
} from "@/server/terms-compliance";
import type {
  CaseAnalysisMode,
  CaseDoc,
  CommercialLineItem,
  DocType,
  ExtractionQualityIssue,
  FieldKey,
  Mismatch,
} from "@/types/pipeline";

import {
  callExtractionReviewModel,
  callOpenRouter,
  getExtractionReviewModel,
  getExtractionReviewProvider,
  getExtractionReviewReasoningEffort,
  getQualityExtractionModel,
  getQualityExtractionReasoning,
} from "./openrouter";

const STORAGE_BUCKET = "packet-files";

const PDF_RENDER_MAX_PAGES = Number(
  process.env.PACKET_PDF_RENDER_MAX_PAGES ?? 40,
);
const PDF_SMART_SPLIT_MAX_PAGES = Number(
  process.env.PACKET_PDF_SMART_SPLIT_MAX_PAGES ?? 40,
);
const PROVIDER_IMAGE_HARD_LIMIT_BYTES = Number(
  process.env.PACKET_PROVIDER_IMAGE_HARD_LIMIT_BYTES ?? 20 * 1024 * 1024,
);
const PROVIDER_IMAGE_TARGET_BYTES = Number(
  process.env.PACKET_PROVIDER_IMAGE_TARGET_BYTES ?? 8 * 1024 * 1024,
);
const PROVIDER_IMAGE_MAX_DIMENSION = Number(
  process.env.PACKET_PROVIDER_IMAGE_MAX_DIMENSION ?? 3200,
);
const REVIEW_IMAGE_MAX_DIMENSION = Math.max(
  1200,
  Math.min(
    2400,
    Number(process.env.PACKET_REVIEW_IMAGE_MAX_DIMENSION ?? 1800) || 1800,
  ),
);
const REVIEW_IMAGE_JPEG_QUALITY = Math.max(
  70,
  Math.min(
    90,
    Number(process.env.PACKET_REVIEW_IMAGE_JPEG_QUALITY ?? 82) || 82,
  ),
);
const PACKET_AI_CONCURRENCY = Math.max(
  1,
  Math.min(6, Number(process.env.PACKET_AI_CONCURRENCY ?? 6) || 6),
);
const PACKET_SPLIT_REASONING_TOKENS = Math.max(
  0,
  Math.min(1000, Number(process.env.PACKET_SPLIT_REASONING_TOKENS ?? 256) || 0),
);
const PACKET_SPLIT_MAX_OUTPUT_TOKENS = Math.max(
  600,
  Math.min(
    4096,
    Number(process.env.PACKET_SPLIT_MAX_OUTPUT_TOKENS ?? 1600) || 1600,
  ),
);
const PACKET_TERMS_MAX_OUTPUT_TOKENS = Math.max(
  800,
  Math.min(
    4096,
    Number(process.env.PACKET_TERMS_MAX_OUTPUT_TOKENS ?? 2200) || 2200,
  ),
);
const PACKET_TERMS_REASONING_TOKENS = Math.max(
  0,
  Math.min(1200, Number(process.env.PACKET_TERMS_REASONING_TOKENS ?? 512) || 0),
);
const PACKET_STRICT_REVIEW_SCHEMA =
  process.env.PACKET_STRICT_REVIEW_SCHEMA !== "false";

function getSplitClassificationReasoning() {
  return PACKET_SPLIT_REASONING_TOKENS > 0
    ? { max_tokens: PACKET_SPLIT_REASONING_TOKENS, exclude: true }
    : undefined;
}
const PHOTO_VEHICLE_NUMBER_NOT_VISIBLE_COPY =
  "Vehicle number is not clearly visible in this image.";
const PO_NUMBER_FIELD_KEYS: FieldKey[] = ["poNumber", "referencePoNumber"];
const INDENT_LABEL_PATTERN =
  /\b(?:indent|ind\.?\s*no|indent\s*(?:no|number|form|ref|reference)?)\b/i;
const PURCHASE_ORDER_LABEL_PATTERN =
  /\b(?:(?:p\.?\s*o\.?|po|purchase\s+order)\s*(?:no|number|#)?|order\s*(?:no|number|#))\b/i;
const IMAGE_HANDWRITTEN_EXTRACTION_INSTRUCTION =
  "Some packet documents are handwritten/manual or mixed printed and handwritten. Treat handwritten entries as first-class visible text, not as noise. Carefully inspect handwritten numbers, dates, party names, vehicle numbers, challan/receipt/permit/certificate numbers, financial amounts, weights, quantities, table cells, stamps, and signatures. Preserve readable handwriting in visibleText. Do not infer a handwritten value from other documents, file names, or nearby labels; if a value is only partly legible, omit the structured field and keep the uncertain transcription in visibleText. ";
const TEXT_HANDWRITTEN_EXTRACTION_INSTRUCTION =
  "This text may come from PDF embedded text/OCR and can omit handwritten entries. Use only the provided text; do not guess handwritten values that are not present. If the text shows manual or handwritten content, preserve it in visibleText and extract it when clearly labelled. ";
const AMOUNT_EXTRACTION_INSTRUCTION =
  "Copy financial amounts exactly as printed, preserving digit count and decimal placement after removing separators. Do not add or drop zeros. Cross-check quantity x rate, taxable amount + tax amount, and subtotal + tax amount before returning totals; if arithmetic conflicts with a visually uncertain amount, prefer the arithmetically consistent value visible in the row/summary. Extract visible GST/tax percentage fields as taxRate, cgstRate, sgstRate, and igstRate; do not put tax percentages into taxAmount. For invoices, extract printed total GST as taxAmount and separately extract freightAmount and freightGstRate; normal income-tax TDS under section 194Q as tds194qAmount and tds194qRate; goods-transport TDS as transportTdsAmount and transportTdsRate; GST withholding as cgstTdsAmount, sgstTdsAmount, igstTdsAmount, and gstTdsRate; and TCS and round-off as tcsAmount and roundOffAmount. Keep deductions separate and never infer an amount that is absent. Use tdsAmount and tdsRate only when the document does not identify the TDS type. Use GSTIN state codes for GST type: compare both supplier and buyer state codes. Do not infer tax type from a single GSTIN or assume a home state. ";
const CONSIGNEE_EXTRACTION_INSTRUCTION =
  "If a party is labelled Consignee, Ship To, or Recipient, map it to buyerName/buyerGstin only when the document also identifies it as the billed buyer. Keep a separate consignee in shipTo or visibleText. Do not infer a buyer from the app brand. ";
const DELIVERY_REFERENCE_EXTRACTION_INSTRUCTION =
  "Treat delivery references by their printed roles: DO No or Delivery Order No maps to deliveryOrderNumber; Delivery Note No, Challan No, or a separately labelled Delivery No maps to deliveryNoteNumber. Preserve both when both are visible and never overwrite one with the other. ";
const DOCUMENT_SOURCE_BOUNDARY_INSTRUCTION =
  "Keep this document's extraction source-bound: every field and every populated line-item property must be visibly printed or handwritten on this document itself. Other packet documents may help interpret the page, but must never supply, complete, or copy a value that is absent here. Omit an absent value instead of inheriting it from another document. Read labels and values together: a document type or heading describes what the document is, not its identifying number. Preserve a blank reference as absent even when a nearby type, date, or other document's identifier is visible. ";
const CONSIGNEE_NAME_ALIASES = new Set([
  "consigneeName",
  "consignee",
  "shipToName",
  "recipientName",
]);
const CONSIGNEE_GSTIN_ALIASES = new Set([
  "consigneeGstin",
  "shipToGstin",
  "recipientGstin",
]);
const INTERNAL_CONSIGNEE_GSTINS = new Set<string>();
const CONSIGNEE_CONTEXT_PATTERN =
  /\b(?:consignee|ship\s*to|ship-to|recipient)\b/i;
const DIRECT_BUYER_CONTEXT_PATTERN =
  /\b(?:buyer|bill\s*to|bill-to|sold\s*to|sold-to|customer|purchaser)\b/i;
const STORE_EVIDENCE_DOC_TYPES = new Set<DocType>([
  "Invoice",
  "Tax Invoice",
  "Delivery Challan",
  "Delivery Note",
]);
const STAMP_SIGNATURE_EXTRACTION_INSTRUCTION =
  "For stamp/signature presence fields, return only Yes, No, or Unclear. Use Yes only when the mark is visibly present, No only when the relevant area is visible and clearly absent, otherwise Unclear. For invoice/delivery receiving evidence, a buyer or receiver stamp block labelled Store, Gate, or Security with Date and Name & Sign lines means hasStoreStamp=Yes; if handwritten marks or signatures appear on those Name & Sign lines, hasStoreSignature=Yes. Do not confuse the supplier Authorized Signatory with store signature. ";

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  handler: (item: T, index: number) => Promise<R>,
) {
  if (!items.length) return [] as R[];

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await handler(
          items[currentIndex],
          currentIndex,
        );
      }
    },
  );
  await Promise.all(workers);
  return results;
}

const SUPPORTED_DOC_TYPES: DocType[] = [
  "Purchase Order",
  "Amended Purchase Order",
  "Invoice",
  "Tax Invoice",
  "E-Way Bill",
  "Weighment Slip",
  "Lorry Receipt",
  "Vehicle Registration Certificate",
  "Driving Licence",
  "PAN Card",
  "FASTag Toll Proof",
  "Material Test Certificate",
  "Photo Evidence",
  "Transport Permit",
  "Receipt",
  "Delivery Note",
  "Delivery Challan",
  "Bank Statement",
  "Map Printout",
  "Payment Screenshot",
  "Unknown",
];

const ALL_ALLOWED_FIELD_KEYS = FIELD_DEFINITIONS.map((field) => field.key);

const FIELD_MAPPINGS: Partial<Record<FieldKey, string[]>> = {
  vendorName: [
    "vendorName",
    "sellerName",
    "supplierName",
    "vendor",
    "seller",
    "supplier",
    "consignorName",
    "issuerName",
  ],
  supplierGstin: [
    "supplierGstin",
    "vendorGstin",
    "sellerGstin",
    "gstin",
    "gstinUin",
  ],
  buyerName: [
    "buyerName",
    "customerName",
    "consigneeName",
    "buyer",
    "customer",
    "consignee",
    "billToName",
    "shipToName",
    "recipientName",
    "purchaserName",
  ],
  buyerGstin: [
    "buyerGstin",
    "customerGstin",
    "consigneeGstin",
    "shipToGstin",
    "billToGstin",
    "recipientGstin",
    "purchaserGstin",
  ],
  poNumber: ["poNumber", "purchaseOrderNumber"],
  poAmendmentNumber: [
    "poAmendmentNumber",
    "amendmentNumber",
    "poVersion",
    "revisionNumber",
  ],
  invoiceNumber: ["invoiceNumber", "billNumber"],
  receiptNumber: ["receiptNumber"],
  deliveryOrderNumber: [
    "deliveryOrderNumber",
    "deliveryOrderNo",
    "doNumber",
    "doNo",
  ],
  deliveryNoteNumber: ["deliveryNoteNumber", "challanNumber"],
  referencePoNumber: [
    "referencePoNumber",
    "poReference",
    "purchaseOrderReference",
  ],
  referenceInvoiceNumber: [
    "referenceInvoiceNumber",
    "invoiceReference",
    "documentNumber",
    "docNumber",
    "docNo",
  ],
  eWayBillNumber: [
    "eWayBillNumber",
    "ewayBillNumber",
    "ewayNumber",
    "wayBillNumber",
  ],
  weighmentNumber: [
    "weighmentNumber",
    "weighmentReceiptNumber",
    "weighmentSlipNumber",
  ],
  weighbridgeName: ["weighbridgeName", "weighBridgeName", "weightBridgeName"],
  lorryReceiptNumber: [
    "lorryReceiptNumber",
    "lrNumber",
    "transportReceiptNumber",
    "transporterDocNumber",
    "transporterDocumentNumber",
    "consignmentNumber",
  ],
  certificateNumber: [
    "certificateNumber",
    "testCertificateNumber",
    "mtcNumber",
    "mtrNumber",
  ],
  certificateDate: [
    "certificateDate",
    "testCertificateDate",
    "mtcDate",
    "certificateIssuedDate",
  ],
  permitNumber: ["permitNumber", "authorisationNumber", "authorizationNumber"],
  permitType: ["permitType", "authorizationType", "permitClass"],
  licenseNumber: [
    "licenseNumber",
    "licenceNumber",
    "drivingLicenseNumber",
    "drivingLicenceNumber",
  ],
  chassisNumber: ["chassisNumber", "vin", "vehicleIdentificationNumber"],
  engineNumber: ["engineNumber", "motorNumber"],
  vehicleClass: ["vehicleClass", "vehicleType"],
  documentDate: [
    "documentDate",
    "invoiceDate",
    "poDate",
    "receiptDate",
    "deliveryDate",
    "generatedDate",
    "eWayBillDate",
  ],
  ackDate: ["ackDate", "acknowledgementDate", "acknowledgmentDate"],
  transactionDate: [
    "transactionDate",
    "transactionTime",
    "transactionDateTime",
    "paymentDate",
    "statementDate",
  ],
  validityDate: [
    "validityDate",
    "validUpto",
    "validUntil",
    "permitValidityDate",
    "licenseValidityDate",
    "licenceValidityDate",
    "registrationValidityDate",
  ],
  dateOfBirth: ["dateOfBirth", "dob", "birthDate"],
  currency: ["currency"],
  subtotal: ["subtotal", "subTotal"],
  totalTaxableAmount: [
    "totalTaxableAmount",
    "totalTaxableAmt",
    "taxableAmount",
    "taxableValue",
    "taxableAmountRs",
  ],
  taxAmount: ["taxAmount", "tax", "gstAmount"],
  taxRate: [
    "taxRate",
    "gstRate",
    "taxPercent",
    "taxPercentage",
    "gstPercent",
    "gstPercentage",
  ],
  cgstRate: ["cgstRate", "centralGstRate", "cgstPercent", "cgstPercentage"],
  sgstRate: ["sgstRate", "stateGstRate", "sgstPercent", "sgstPercentage"],
  igstRate: ["igstRate", "integratedGstRate", "igstPercent", "igstPercentage"],
  tdsAmount: ["tdsAmount", "taxDeductedAtSource", "tdsDeducted", "tds"],
  tdsRate: ["tdsRate", "tdsPercent", "tdsPercentage"],
  tds194qAmount: ["tds194qAmount", "section194qAmount", "tdsPayable194q"],
  tds194qRate: ["tds194qRate", "section194qRate"],
  transportTdsAmount: [
    "transportTdsAmount",
    "goodsTransportTdsAmount",
    "freightTdsAmount",
  ],
  transportTdsRate: [
    "transportTdsRate",
    "goodsTransportTdsRate",
    "freightTdsRate",
  ],
  cgstTdsAmount: ["cgstTdsAmount", "cgstWithholdingAmount"],
  sgstTdsAmount: ["sgstTdsAmount", "sgstWithholdingAmount"],
  igstTdsAmount: ["igstTdsAmount", "igstWithholdingAmount"],
  gstTdsRate: ["gstTdsRate", "gstWithholdingRate"],
  tcsAmount: ["tcsAmount", "taxCollectedAtSource", "tcsCollected", "tcs"],
  roundOffAmount: [
    "roundOffAmount",
    "roundoffAmount",
    "roundingAmount",
    "roundOff",
  ],
  totalAmount: ["totalAmount", "grandTotal", "documentTotal"],
  paymentTerms: [
    "paymentTerms",
    "paymentTerm",
    "termsOfPayment",
    "paymentCondition",
  ],
  deliveryTerms: [
    "deliveryTerms",
    "deliveryTerm",
    "deliveryPeriod",
    "deliverySchedule",
    "deliveryCondition",
  ],
  freightTerms: [
    "freightTerms",
    "freightTerm",
    "transportTerms",
    "transportationTerms",
    "freightCondition",
  ],
  packingForwardingTerms: [
    "packingForwardingTerms",
    "packingTerms",
    "forwardingTerms",
    "pfTerms",
    "pAndFTerms",
    "packingAndForwarding",
  ],
  priceBasis: ["priceBasis", "basisOfPrice", "pricingBasis", "rateBasis"],
  taxTerms: ["taxTerms", "gstTerms", "taxCondition", "dutiesAndTaxes"],
  inspectionTerms: [
    "inspectionTerms",
    "qualityTerms",
    "testingTerms",
    "testCertificateTerms",
  ],
  warrantyTerms: ["warrantyTerms", "guaranteeTerms", "warrantyGuaranteeTerms"],
  termsAndConditions: [
    "termsAndConditions",
    "termsConditions",
    "commercialTerms",
    "specialTerms",
    "generalTerms",
    "remarks",
  ],
  paidAmount: [
    "paidAmount",
    "amountPaid",
    "paidTollAmount",
    "tollAmount",
    "amountReceived",
    "receivedAmount",
  ],
  statementAmount: [
    "statementAmount",
    "availableBalance",
    "availableBal",
    "avblBal",
    "balance",
    "debitAmount",
    "creditAmount",
    "transactionAmount",
  ],
  freightAmount: ["freightAmount", "freight", "transportCharge"],
  freightGstRate: ["freightGstRate", "freightTaxRate", "transportGstRate"],
  advanceAmount: ["advanceAmount", "advancePaid"],
  toPayAmount: ["toPayAmount", "toPay", "ttbAmount"],
  itemDescription: ["itemDescription", "description", "productDescription"],
  materialGrade: ["materialGrade", "grade", "steelGrade"],
  itemQuantity: ["itemQuantity", "quantity", "qty"],
  unit: ["unit", "uom"],
  hsnSac: ["hsnSac", "hsn", "sac", "hsnCode"],
  batchNumber: ["batchNumber", "batchNo", "lotNumber"],
  heatNumber: ["heatNumber", "heatNo", "castLotNo"],
  vehicleNumber: [
    "vehicleNumber",
    "truckNumber",
    "lorryNumber",
    "vehicleNo",
    "truckNo",
  ],
  registrationNumber: [
    "registrationNumber",
    "registrationNo",
    "rcNumber",
    "regnNumber",
  ],
  ownerName: ["ownerName", "registeredOwnerName"],
  transporterName: [
    "transporterName",
    "transporter",
    "transportName",
    "carrierName",
  ],
  driverName: ["driverName", "licenceHolderName", "licenseHolderName"],
  holderName: ["holderName", "nameOnCard", "panHolderName"],
  fatherName: ["fatherName", "fatherOrSpouseName"],
  panNumber: ["panNumber", "panNo"],
  fuelType: ["fuelType"],
  grossWeight: ["grossWeight", "grossWt"],
  tareWeight: ["tareWeight", "tareWt"],
  netWeight: ["netWeight", "netWt"],
  bankName: ["bankName"],
  accountNumber: ["accountNumber", "accountNo"],
  irnNumber: ["irnNumber", "irn"],
  ackNumber: ["ackNumber", "acknowledgementNumber", "acknowledgmentNumber"],
  transactionReference: [
    "transactionReference",
    "utrNumber",
    "referenceNumber",
    "paymentReference",
  ],
  fastagReference: [
    "fastagReference",
    "fastagId",
    "tagId",
    "tagNumber",
    "tag",
    "transactionId",
  ],
  fastagStatementReference: [
    "fastagStatementReference",
    "statementReferenceNumber",
    "statementReference",
  ],
  fastagCustomerId: ["fastagCustomerId", "customerId", "customerID"],
  fastagCustomerName: ["fastagCustomerName", "customerName", "tagCustomerName"],
  statementPeriod: ["statementPeriod", "period"],
  statementDate: ["statementDate"],
  openingBalance: ["openingBalance", "openingBal"],
  creditAmount: ["creditAmount", "credit", "totalCredit"],
  debitAmount: ["debitAmount", "debit", "totalDebit"],
  closingBalance: ["closingBalance", "closingBal"],
  tripCount: ["tripCount", "totalTrips"],
  tollTransactionSummary: [
    "tollTransactionSummary",
    "transactionSummary",
    "tripSummary",
  ],
  tollPlaza: ["tollPlaza", "plazaName", "tollLocation"],
  dispatchFrom: ["dispatchFrom", "originAddress", "dispatchAddress"],
  shipTo: ["shipTo", "deliveryAddress", "consigneeAddress"],
  routeFrom: ["routeFrom", "origin", "fromLocation"],
  routeTo: ["routeTo", "destination", "toLocation"],
  mapLocation: ["mapLocation", "address", "registeredAddress", "holderAddress"],
  photoTimestamp: ["photoTimestamp", "captureTimestamp", "evidenceTimestamp"],
  evidenceDescription: [
    "evidenceDescription",
    "photoDescription",
    "observation",
  ],
  hasAuthorizedSignature: [
    "hasAuthorizedSignature",
    "authorizedSignature",
    "authorisedSignature",
    "signaturePresent",
    "hasSignature",
  ],
  hasVendorStamp: [
    "hasVendorStamp",
    "vendorStamp",
    "supplierStamp",
    "sellerStamp",
    "stampPresent",
  ],
  hasStoreStamp: [
    "hasStoreStamp",
    "storeStamp",
    "receivingStoreStamp",
    "warehouseStamp",
  ],
  hasStoreSignature: [
    "hasStoreSignature",
    "storeSignature",
    "receivingSignature",
    "warehouseSignature",
  ],
  hasGateStamp: [
    "hasGateStamp",
    "gateStamp",
    "gateEntryStamp",
    "securityStamp",
  ],
};

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    const trimmed = raw.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    const jsonString =
      start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
    return JSON.parse(jsonString) as T;
  } catch {
    return fallback;
  }
}

function toText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value))
    return value
      .map((entry) => toText(entry))
      .filter(Boolean)
      .join("\n");
  if (value && typeof value === "object") {
    return Object.values(value)
      .map((entry) => toText(entry))
      .filter(Boolean)
      .join("\n");
  }
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function formatDocType(docType: DocType) {
  return docType === "Unknown" ? "Document" : docType;
}

function getAllowedFieldKeysForDocType(docType: DocType) {
  const docTypeFieldKeys = getFieldKeysForDocType(docType);
  return docTypeFieldKeys.length > 0
    ? docTypeFieldKeys
    : ALL_ALLOWED_FIELD_KEYS;
}

function getLineItemExtractionInstruction(docType: DocType) {
  if (!isCommercialDocType(docType)) {
    return "";
  }

  return (
    "Also extract every commercial table row into a top-level lineItems array. " +
    "Each line item may contain lineNumber, itemCode, description, hsnSac, quantity, unit, rate, discountPercent, netRate, taxableAmount, cgstRate, cgstAmount, sgstRate, sgstAmount, igstRate, igstAmount, taxRate, taxAmount, lineTotal, referencePoLineNumber, rawText, and sourcePage. " +
    "When the prompt text or rendered images contain multiple pages, set sourcePage to the visible page number where the row appears. " +
    'Preserve the full item description, including dimensions, material grade and specifications. Extract itemCode only from an explicit code column, label, or clearly separated code prefix: "CH150 - MS Channel 150 x 75 mm, Grade E250" means itemCode "CH150" and description "MS Channel 150 x 75 mm, Grade E250". Do not move dimensions or specifications into itemCode. If a separate code is unclear, keep the full description and omit itemCode. ' +
    "Preserve one entry per visible PO, invoice, delivery challan/note, or e-way bill goods row; do not merge different rows or sum unlike units. Use rawText for the original row text when OCR is uncertain. " +
    "Do not extract HSN/SAC-wise tax summary rows as lineItems. Rows that only contain HSN/SAC, taxable value, and tax amount are summary rows, not product/service lines. " +
    "When invoice GST rates appear only in an HSN/SAC tax summary, map the visible CGST, SGST, IGST, or GST rates from that summary onto the matching product/service lineItems by HSN/SAC and taxable amount. " +
    "For invoice rows, taxableAmount is the row amount before GST; when the row shows only quantity, rate, and amount, use that amount as taxableAmount and lineTotal. Do not treat packing, freight, P&F, or other charge percentages as GST rates unless the row or tax summary explicitly labels CGST, SGST, IGST, GST, or tax. " +
    "Distinguish package counts such as pieces, bags, bundles, or coils from the billed quantity. When the rate is printed per KG, MT, TO, tonne, or another weight unit, quantity and unit must be the weight used in quantity × rate = taxableAmount; do not use the package count as the billed quantity. " +
    "Only set taxableAmount or lineTotal when a monetary amount/value column is visible. Do not use quantity totals such as TOTAL 1.000 as monetary amounts, and omit amount fields instead of writing 0 when the document does not show an amount. " +
    "For product/service rows, keep the full product specification in description, an explicitly identified item code in itemCode, and HSN/SAC only in hsnSac. Never copy HSN/SAC codes, GST labels, quantity-column values, units, rates, tax rates, taxable amounts, tax amounts, or totals into description or itemCode. " +
    "Populate a tax rate or tax amount on a line item only when that tax value is visibly printed on this same document. Never carry tax data from another invoice, e-way bill, purchase order, or packet page into a delivery note/challan row. "
  );
}

function getDocumentSpecificExtractionInstruction(docType: DocType) {
  switch (docType) {
    case "Purchase Order":
    case "Amended Purchase Order":
      return (
        "For Purchase Order documents, poNumber must be the value explicitly labelled PO No, P.O. No, Purchase Order No, or Order No. " +
        "Never use Indent No, Indent Number, Indent Form, requisition number, or internal indent reference as poNumber; omit poNumber if only an indent number is visible. " +
        "Extract Order Date, PO Date, P.O. Date, or Purchase Order Date as documentDate. Prefer Order Date over Party Ref Date, delivery date, or validity date. " +
        "A requested delivery date or delivery-by date is a schedule value, not deliveryTerms. Put only printed delivery obligations such as destination, lead time, dispatch condition, or delivery basis in deliveryTerms; keep payment wording only in paymentTerms. Do not concatenate neighbouring labels or values into one field. " +
        "Capture PO commercial terms from header, footer, remarks, notes, special instructions, and Terms & Conditions sections. " +
        "Extract paymentTerms, deliveryTerms, freightTerms, packingForwardingTerms, priceBasis, taxTerms, inspectionTerms, and warrantyTerms when visible. " +
        "Also fill termsAndConditions with a compact semicolon-separated summary of all visible PO clauses, preserving the original commercial meaning. Do not invent missing terms. "
      );
    case "Tax Invoice":
    case "Invoice":
      return (
        "For invoice documents, extract the supplier invoice date as documentDate. It may be labelled Invoice Date, Date of Invoice, Date, or Dated beside the Invoice No.; return it as YYYY-MM-DD. Do not substitute Ack Date, dispatch date, LR date, e-Way Bill generated date, digitally signed timestamp, or a footer/print date. " +
        "For invoice documents, referencePoNumber must be a value explicitly labelled PO No, P.O. No, Purchase Order No, Buyer PO, or Order No. " +
        "Use the printed PO label, not a client-specific number format, to identify the reference. Never substitute SO No, DO No, Delivery No, delivery-order number, the supplier invoice number, or a date. If multiple labelled PO references are ambiguous, omit the field. " +
        "Keep freight and delivery semantics separate. A value printed as Freight, Freight Terms, Freight Status, Paid, To Pay, Prepaid, or freight-inclusive belongs in freightTerms; deliveryTerms is only for a delivery schedule, destination, lead time, dispatch condition, or delivery basis. Never place PREPAID or TO PAY in deliveryTerms when it describes freight. " +
        "For invoice documents, eWayBillNumber must be the 12-digit E-Way Bill number only. Do not use transporter document numbers, online order tracking numbers, LR numbers, acknowledgement numbers, or receipt numbers as eWayBillNumber. Do not put a 12-digit E-Way Bill number into irnNumber; IRN is the long invoice reference hash. " +
        "Extract LR No, LR/RR No, Consignment Note No, or Transporter Doc No as lorryReceiptNumber. Extract visibly printed gross, tare, and net weights into grossWeight, tareWeight, and netWeight with their KG, MT, or TO unit. " +
        "Never use Indent No, Indent Number, Indent Form, requisition number, or internal indent reference as referencePoNumber. "
      );
    case "Delivery Challan":
    case "Delivery Note":
      return (
        "For Delivery Challan or Delivery Note documents, itemQuantity must be the actual goods/item quantity from a goods row. " +
        "Never set itemQuantity from Total Packages, No. of packages, boxes, cartons, bundles, bags, coils packed, packing count, or shipment count. " +
        "If only package count is visible and no actual goods quantity is shown, omit itemQuantity. " +
        "Extract every explicitly labelled packet reference that is present on this page, including Delivery Note/Challan No as deliveryNoteNumber, Reference Invoice/Invoice No as referenceInvoiceNumber, Reference PO/PO No as referencePoNumber, E-Way Bill No as eWayBillNumber, LR/Consignment/Transporter Doc No as lorryReceiptNumber, and Vehicle No as vehicleNumber. " +
        "Extract the issuing supplier and billed/receiving buyer, including their GSTINs when printed. These references and parties must come from this delivery document itself, never from another packet page. "
      );
    case "E-Way Bill":
      return (
        "For E-Way Bill documents, vendorName is the From party name in Address Details after the first GSTIN, and buyerName is the To party name after the second GSTIN. " +
        "Do not use Dispatch From or Ship To address text as party names; those belong in dispatchFrom and shipTo. " +
        "Extract Generated Date as documentDate, Valid Upto/Valid Until as validityDate, Tot. Tax'ble Amt or Taxable Amount as totalTaxableAmount and subtotal, Total Inv. Amt as totalAmount, CGST+SGST+IGST+Cess amounts or total minus taxable amount as taxAmount, and derive taxRate from taxAmount/subtotal when the percentage is not printed. " +
        "Extract Transporter ID & Name into transporterName, Transporter Doc. No into lorryReceiptNumber, and the Part-B Vehicle/Trans number into vehicleNumber. When the Transporter Doc. No cell also prints its date, keep only the document identifier in lorryReceiptNumber; do not append the adjacent date to the identifier. " +
        "If Part-A shows Doc No, Document No, Invoice No, Tax Invoice No, or Delivery Challan No, extract that value as referenceInvoiceNumber unless it is the E-Way Bill No itself. "
      );
    case "Lorry Receipt":
      return (
        "For Lorry Receipt documents, prioritize lorryReceiptNumber, vehicleNumber, routeFrom, routeTo, transporterName, netWeight, and authorized signature presence. " +
        "vendorName is the party explicitly labelled Consignor, not the carrier/transporter, loading point, booking office, or a party copied from another page. buyerName is the explicitly labelled billed buyer; keep a consignee-only party separate unless the page also identifies it as buyer. " +
        "Preserve the printed KG or MT unit inside weight fields; never return a bare weight number when its unit is visible. " +
        "Extract GST Inv. No, Invoice No, or Tax Invoice No as referenceInvoiceNumber and an explicitly labelled GST Invoice Value or Invoice Value as totalAmount. Do not use freight, advance, or to-pay amounts as totalAmount. " +
        "Lorry No is the vehicleNumber. G.C. Note, LR No, Consignment No, or Transporter Doc No is lorryReceiptNumber. " +
        "Do not return package, freight, weight, amount, total, to-pay, or to-be-billed rows as lineItems; keep logistics quantities and weights in fields only. " +
        "Read Indian vehicle numbers carefully from the image; distinguish letters from similar-looking digits, especially G/9, J/S, O/0, S/5, T/7, D/G, and C/G. "
      );
    case "PAN Card":
      return (
        "For PAN Card documents, prioritize panNumber, holderName, fatherName, and dateOfBirth. " +
        "PAN number is a 10-character Indian PAN like ABCDE1234F; do not leave it blank if visible. "
      );
    case "Driving Licence":
      return (
        "For Driving Licence documents, prioritize licenseNumber, driverName, dateOfBirth, validityDate, and mapLocation/address. " +
        "The licence number may be labelled DL No, Licence No, License No, or DL Number. "
      );
    case "Vehicle Registration Certificate":
      return "For Vehicle Registration Certificate documents, prioritize registrationNumber, vehicleNumber, ownerName, chassisNumber, engineNumber, vehicleClass, fuelType, validityDate, and address. ";
    case "Weighment Slip":
      return (
        "For Weighment Slip documents, prioritize vehicleNumber/lorry number, grossWeight, tareWeight, netWeight, weighmentNumber, weighbridgeName, and authorized signature presence. " +
        "Extract a separately labelled LR No, Lorry Receipt, Consignment Note, or Transporter Doc No as lorryReceiptNumber, and keep invoice and PO references in their own reference fields. " +
        "The company printed in the page header is the weighbridgeName, not vendorName. If a separate CUSTOMER or PARTY field is visible, use that labelled value for vendorName. " +
        "Preserve KG or MT in every weight field. Re-read every digit and confirm grossWeight minus tareWeight equals netWeight. If the net weight is also printed in words, use that line to confirm the digit count and trailing zeroes. If the three visibly printed weights still conflict, preserve all three exactly as printed; do not hide the source calculation problem by omitting or rewriting one value. " +
        "Lorry No or Vehicle No on a weighment slip is the vehicleNumber, not lorryReceiptNumber. Do not use RST No, receipt number, ticket number, tare/gross/net weight, date, or charges as vehicleNumber. " +
        "Do not return weighment rows or weight tables as lineItems; keep gross, tare, and net weights in fields only. " +
        "Read Indian vehicle numbers carefully from the image; distinguish letters from similar-looking digits, especially G/9, L/1, O/0, S/5, T/7, D/G, and C/G. "
      );
    case "Photo Evidence":
      return (
        "For Photo Evidence documents, only return vehicleNumber when the full registration plate characters are clearly readable in the image itself. " +
        `Do not infer a vehicle number from the file name, surrounding documents, or a partial/blurred/cropped plate. If the plate is not clearly visible, omit vehicleNumber and set evidenceDescription to "${PHOTO_VEHICLE_NUMBER_NOT_VISIBLE_COPY}" `
      );
    default:
      return "";
  }
}

function isNonVisibleVehicleNumberValue(value?: string) {
  const compact = value?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  if (!compact) return true;

  return (
    compact === "na" ||
    compact === "notavailable" ||
    compact === "unknown" ||
    compact === "unclear" ||
    compact === "illegible" ||
    compact === "unreadable" ||
    compact.includes("notvisible") ||
    compact.includes("notclearlyvisible") ||
    compact.includes("notreadable") ||
    compact.includes("numbernotvisible") ||
    compact.includes("platenotvisible") ||
    compact.includes("blurred") ||
    compact.includes("obscured") ||
    compact.includes("cropped") ||
    compact.includes("partial")
  );
}

function isLikelyVisibleVehicleNumber(value?: string) {
  if (!value || isNonVisibleVehicleNumberValue(value)) return false;
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (
    compact.length >= 7 &&
    compact.length <= 12 &&
    /[A-Z]/.test(compact) &&
    /\d/.test(compact)
  );
}

function applyPhotoEvidenceVehicleVisibilityCopy(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType,
) {
  if (docType !== "Photo Evidence") return fields;

  const next = { ...fields };
  if (isLikelyVisibleVehicleNumber(next.vehicleNumber)) return next;

  delete next.vehicleNumber;
  const description = next.evidenceDescription?.trim();
  if (!description) {
    next.evidenceDescription = PHOTO_VEHICLE_NUMBER_NOT_VISIBLE_COPY;
    return next;
  }

  const compactDescription = description
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (
    !compactDescription.includes("vehiclenumber") ||
    !compactDescription.includes("visible")
  ) {
    next.evidenceDescription = `${description} ${PHOTO_VEHICLE_NUMBER_NOT_VISIBLE_COPY}`;
  }

  return next;
}

function normalizeIdentifierForContext(value?: string) {
  return value?.toUpperCase().replace(/[^A-Z0-9]/g, "") ?? "";
}

function getValueContexts(visibleText: string, value: string) {
  const candidate = normalizeIdentifierForContext(value);
  if (!candidate) return [];

  const lines = visibleText
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const contexts = new Set<string>();

  lines.forEach((line, index) => {
    if (normalizeIdentifierForContext(line).includes(candidate)) {
      contexts.add(line);
      if (index > 0) contexts.add(`${lines[index - 1]} ${line}`);
      if (index < lines.length - 1) contexts.add(`${line} ${lines[index + 1]}`);
    }
  });

  return [...contexts];
}

function isInternalConsigneeName(value?: string) {
  void value;
  return false; // No company-specific consignee exceptions.
}

function normalizeGstinSignal(value?: string) {
  return value?.toUpperCase().replace(/[^A-Z0-9]/g, "") ?? "";
}

function isInternalConsigneeGstin(value?: string) {
  const normalized = normalizeGstinSignal(value);
  return Boolean(normalized && INTERNAL_CONSIGNEE_GSTINS.has(normalized));
}

function shouldAcceptMappedAlias(
  fieldKey: FieldKey,
  alias: string,
  value: string,
) {
  if (fieldKey === "buyerName" && CONSIGNEE_NAME_ALIASES.has(alias)) {
    return isInternalConsigneeName(value);
  }

  if (fieldKey === "buyerGstin" && CONSIGNEE_GSTIN_ALIASES.has(alias)) {
    return isInternalConsigneeGstin(value);
  }

  return true;
}

function isConsigneeOnlyContext(visibleText: string, value: string) {
  const contexts = getValueContexts(visibleText, value);
  if (!contexts.length) return false;

  const hasConsigneeContext = contexts.some((context) =>
    CONSIGNEE_CONTEXT_PATTERN.test(context),
  );
  const hasDirectBuyerContext = contexts.some((context) =>
    DIRECT_BUYER_CONTEXT_PATTERN.test(context),
  );
  return hasConsigneeContext && !hasDirectBuyerContext;
}

function applyConsigneeBuyerGuard(
  fields: Partial<Record<FieldKey, string>>,
  visibleText: string,
  documentType?: DocType,
) {
  if (!visibleText.trim()) return fields;
  // The E-Way Bill's Recipient/To party is the statutory buyer identity used
  // throughout packet verification, rather than an unlabelled ship-to alias.
  if (documentType === "E-Way Bill") return fields;

  const next = { ...fields };
  let changed = false;
  let droppedConsigneeBuyerName = false;

  if (
    next.buyerName &&
    !isInternalConsigneeName(next.buyerName) &&
    isConsigneeOnlyContext(visibleText, next.buyerName)
  ) {
    delete next.buyerName;
    droppedConsigneeBuyerName = true;
    changed = true;
  }

  if (
    next.buyerGstin &&
    !isInternalConsigneeGstin(next.buyerGstin) &&
    (droppedConsigneeBuyerName ||
      isConsigneeOnlyContext(visibleText, next.buyerGstin))
  ) {
    delete next.buyerGstin;
    changed = true;
  }

  return changed ? next : fields;
}

function isIndentNumberMasqueradingAsPo(value: string, visibleText: string) {
  const contexts = getValueContexts(visibleText, value);
  if (!contexts.length) return false;

  const hasIndentContext = contexts.some((context) =>
    INDENT_LABEL_PATTERN.test(context),
  );
  const hasExplicitPoContext = contexts.some(
    (context) =>
      PURCHASE_ORDER_LABEL_PATTERN.test(context) &&
      !INDENT_LABEL_PATTERN.test(context),
  );

  return hasIndentContext && !hasExplicitPoContext;
}

function applyPoNumberLabelGuard(
  fields: Partial<Record<FieldKey, string>>,
  visibleText: string,
) {
  if (!visibleText.trim()) return fields;

  const next = { ...fields };
  PO_NUMBER_FIELD_KEYS.forEach((fieldKey) => {
    const value = next[fieldKey];
    if (value && isIndentNumberMasqueradingAsPo(value, visibleText)) {
      delete next[fieldKey];
    }
  });

  return next;
}

function isInvoiceDocType(docType: DocType) {
  return docType === "Invoice" || docType === "Tax Invoice";
}

const PO_TERMS_FIELD_KEYS: FieldKey[] = [
  "paymentTerms",
  "deliveryTerms",
  "freightTerms",
  "packingForwardingTerms",
  "priceBasis",
  "taxTerms",
  "inspectionTerms",
  "warrantyTerms",
];
const TERMS_FIELD_KEYS: FieldKey[] = [
  ...PO_TERMS_FIELD_KEYS,
  "termsAndConditions",
];
const TERMS_COMPLIANCE_MISMATCH_PREFIX = "terms-compliance";

const PO_TERM_LABELS: Array<{
  field: FieldKey;
  label: string;
  pattern: RegExp;
}> = [
  {
    field: "paymentTerms",
    label: "Payment",
    pattern: /^(?:payment\s+terms?|terms?\s+of\s+payment|payment)$/i,
  },
  {
    field: "deliveryTerms",
    label: "Delivery",
    pattern: /^(?:delivery\s+(?:terms?|period|schedule|date)|delivery)$/i,
  },
  {
    field: "freightTerms",
    label: "Freight",
    pattern: /^(?:freight|transport(?:ation)?\s+terms?|transport|dispatch)$/i,
  },
  {
    field: "packingForwardingTerms",
    label: "Packing / Forwarding",
    pattern:
      /^(?:packing(?:\s*&\s*forwarding)?|p\s*&\s*f|p\s+and\s+f|forwarding)$/i,
  },
  {
    field: "priceBasis",
    label: "Price Basis",
    pattern: /^(?:price\s+basis|basis\s+of\s+price|rate\s+basis|basis)$/i,
  },
  {
    field: "taxTerms",
    label: "Tax",
    pattern: /^(?:tax(?:es)?|gst|duties(?:\s*&\s*taxes)?|tax\s+terms?)$/i,
  },
  {
    field: "inspectionTerms",
    label: "Inspection",
    pattern: /^(?:inspection|quality|testing|test\s+certificate|tc)$/i,
  },
  {
    field: "warrantyTerms",
    label: "Warranty",
    pattern: /^(?:warranty|guarantee|warranty\s*\/\s*guarantee)$/i,
  },
];

function isPurchaseOrderDocType(docType: DocType) {
  return docType === "Purchase Order" || docType === "Amended Purchase Order";
}

const PURCHASE_ORDER_DOCUMENT_DATE_PATTERN =
  "(\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|\\d{1,2}\\s*[-/.]\\s*[A-Za-z]{3,9}\\s*[-/.]\\s*\\d{2,4})";

function cleanPurchaseOrderDocumentDate(value?: string) {
  return value
    ?.replace(/\s*([-/])\s*/g, "$1")
    .replace(/\s*\.\s*/g, ".")
    .trim()
    .toUpperCase();
}

function extractPurchaseOrderDocumentDate(visibleText: string) {
  const text = visibleText.replace(/\s+/g, " ").trim();
  const dateLabel =
    "(?:(?:Purchase\\s+Order|P\\.?\\s*O\\.?|PO|Order)\\s+Date|Date\\s+of\\s+(?:Purchase\\s+Order|P\\.?\\s*O\\.?|PO|Order))";
  const direct = text.match(
    new RegExp(
      `\\b${dateLabel}\\s*:?\\s*${PURCHASE_ORDER_DOCUMENT_DATE_PATTERN}`,
      "i",
    ),
  )?.[1];
  const reversed = text.match(
    new RegExp(
      `${PURCHASE_ORDER_DOCUMENT_DATE_PATTERN}\\s*${dateLabel}\\b`,
      "i",
    ),
  )?.[1];
  return cleanPurchaseOrderDocumentDate(direct ?? reversed);
}

function applyPurchaseOrderDateFallback(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType,
  visibleText: string,
) {
  if (
    !isPurchaseOrderDocType(docType) ||
    fields.documentDate ||
    !visibleText.trim()
  )
    return fields;

  const documentDate = extractPurchaseOrderDocumentDate(visibleText);
  return documentDate ? { ...fields, documentDate } : fields;
}

function removeNonRequiredPurchaseOrderPresenceFields(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType,
) {
  if (!isPurchaseOrderDocType(docType) || !fields.hasVendorStamp) return fields;

  const next = { ...fields };
  delete next.hasVendorStamp;
  return next;
}

function hasReceivingStoreStampEvidence(visibleText: string) {
  const hasInternalReceiver = false;
  const hasReceivingStampLanguage =
    /\b(?:store|stores|warehouse|receiv(?:ed|ing)|gate|security)\b[\s\S]{0,100}\b(?:stamp|seal|division)\b/i.test(
      visibleText,
    ) ||
    /\b(?:stamp|seal)\b[\s\S]{0,100}\b(?:store|stores|warehouse|receiv(?:ed|ing)|gate|security)\b/i.test(
      visibleText,
    );
  const hasNameSignBlock =
    /\b(?:name\s*&\s*sign|name\s+and\s+sign|name\s*\/\s*sign)\b/i.test(
      visibleText,
    );

  return hasReceivingStampLanguage || (hasInternalReceiver && hasNameSignBlock);
}

function hasReceivingStoreSignatureEvidence(visibleText: string) {
  if (!hasReceivingStoreStampEvidence(visibleText)) return false;
  return /\b(?:name\s*&\s*sign|name\s+and\s+sign|name\s*\/\s*sign|signature|signed|signatory)\b/i.test(
    visibleText,
  );
}

function applyVisibleStoreEvidenceFallback(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType,
  visibleText: string,
) {
  if (!STORE_EVIDENCE_DOC_TYPES.has(docType) || !visibleText.trim())
    return fields;

  const hasStoreStamp = hasReceivingStoreStampEvidence(visibleText);
  const hasStoreSignature = hasReceivingStoreSignatureEvidence(visibleText);
  if (!hasStoreStamp && !hasStoreSignature) return fields;

  const next = { ...fields };
  if (hasStoreStamp && next.hasStoreStamp !== "Yes") {
    next.hasStoreStamp = "Yes";
  }
  if (hasStoreSignature && next.hasStoreSignature !== "Yes") {
    next.hasStoreSignature = "Yes";
  }
  return next;
}

function cleanPoTermText(value?: string) {
  const cleaned = value
    ?.replace(/\s+/g, " ")
    .replace(/^[\s:;,\-.•*#]+/, "")
    .replace(/[\s;,\-.]+$/, "")
    .trim();
  if (!cleaned || cleaned.length < 2) return undefined;
  return cleaned.slice(0, 1800);
}

function splitPoTermLine(line: string) {
  const colonIndex = line.search(/[:：]/);
  if (colonIndex >= 0) {
    return {
      label: line
        .slice(0, colonIndex)
        .replace(/^\d+\s*[)./-]?\s*/, "")
        .trim(),
      value: line.slice(colonIndex + 1).trim(),
    };
  }

  const spaced = line.match(/^(.{3,45}?)\s{2,}(.+)$/);
  if (spaced) {
    return {
      label: spaced[1].replace(/^\d+\s*[)./-]?\s*/, "").trim(),
      value: spaced[2].trim(),
    };
  }

  return { label: line.replace(/^\d+\s*[)./-]?\s*/, "").trim(), value: "" };
}

function isPoTermsSectionStart(line: string) {
  return /^(?:terms?\s*(?:&|and)?\s*conditions?|commercial\s+terms?|special\s+terms?|general\s+terms?|remarks?|notes?|other\s+terms?)\b/i.test(
    line.trim(),
  );
}

function isPoTermsStopLine(line: string) {
  return /^(?:for\s+[A-Z].*|authori[sz]ed\s+signatory|prepared\s+by|checked\s+by|approved\s+by|receiver'?s?\s+signature|page\s+\d+\s+of\s+\d+)\b/i.test(
    line.trim(),
  );
}

function collectPoContinuation(lines: string[], startIndex: number) {
  const collected: string[] = [];
  for (
    let index = startIndex;
    index < Math.min(lines.length, startIndex + 3);
    index += 1
  ) {
    const line = lines[index];
    if (!line || isPoTermsStopLine(line) || isPoTermsSectionStart(line)) break;
    const { label, value } = splitPoTermLine(line);
    if (value && PO_TERM_LABELS.some((term) => term.pattern.test(label))) break;
    collected.push(line);
  }
  return collected.join(" ");
}

function extractPoTermsSection(lines: string[]) {
  const startIndex = lines.findIndex(isPoTermsSectionStart);
  if (startIndex < 0) return undefined;

  const sectionLines: string[] = [];
  for (
    let index = startIndex;
    index < Math.min(lines.length, startIndex + 45);
    index += 1
  ) {
    const line = lines[index];
    if (!line) {
      if (sectionLines.length > 8) break;
      continue;
    }
    if (index > startIndex && isPoTermsStopLine(line)) break;
    sectionLines.push(line);
  }

  return cleanPoTermText(sectionLines.join("; "));
}

function extractPoTermsFromVisibleText(
  visibleText: string,
): Partial<Record<FieldKey, string>> {
  const lines = visibleText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const terms: Partial<Record<FieldKey, string>> = {};

  lines.forEach((line, index) => {
    const { label, value } = splitPoTermLine(line);
    const matched = PO_TERM_LABELS.find((term) => term.pattern.test(label));
    if (!matched || terms[matched.field]) return;
    const candidate = cleanPoTermText(
      value || collectPoContinuation(lines, index + 1),
    );
    if (candidate) terms[matched.field] = candidate;
  });

  const termsSection = extractPoTermsSection(lines);
  const structuredSummary = PO_TERMS_FIELD_KEYS.map((field) => {
    const value = terms[field];
    const label = PO_TERM_LABELS.find((term) => term.field === field)?.label;
    return value && label ? `${label}: ${value}` : null;
  })
    .filter(Boolean)
    .join("; ");
  const termsAndConditions = cleanPoTermText(termsSection ?? structuredSummary);
  if (termsAndConditions) {
    terms.termsAndConditions = termsAndConditions;
  }

  return terms;
}

function applyPurchaseOrderTermsFallback(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType,
  visibleText: string,
) {
  if (!isPurchaseOrderDocType(docType) || !visibleText.trim()) return fields;

  const terms = extractPoTermsFromVisibleText(visibleText);
  return Object.entries(terms).reduce(
    (acc, [key, value]) => {
      const fieldKey = key as FieldKey;
      if (value && !acc[fieldKey]) acc[fieldKey] = value;
      return acc;
    },
    { ...fields } as Partial<Record<FieldKey, string>>,
  );
}

type TermsComplianceAssessment = {
  sourceDocId?: unknown;
  sourceClause?: unknown;
  obligation?: unknown;
  category?: unknown;
  status?: unknown;
  evidenceDocIds?: unknown;
  evidence?: unknown;
  reason?: unknown;
  severity?: unknown;
};

export type TermsComplianceChecklistItem = {
  sourceDocId: string;
  sourceClause: string;
  obligation: string;
  category: string;
  status: "fulfilled" | "not_fulfilled" | "unknown" | "not_applicable";
  evidenceDocIds: string[];
  evidence: string;
  reason: string;
  severity: "high" | "medium" | "low" | "none";
};

function compactPromptText(value: string, maxLength: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 20).trim()} ... [truncated]`;
}

function getTermsFieldSummary(doc: CaseDoc) {
  return TERMS_FIELD_KEYS.map((field) => {
    const value = doc.fields[field];
    return value && String(value).trim()
      ? `${FIELD_LABELS[field]}: ${String(value).trim()}`
      : null;
  }).filter((value): value is string => Boolean(value));
}

function fieldSummaryForTermsAssessment(doc: CaseDoc) {
  return Object.entries(doc.fields)
    .filter(
      ([, value]) =>
        value !== undefined &&
        value !== null &&
        String(value).trim().length > 0,
    )
    .slice(0, 80)
    .map(
      ([key, value]) =>
        `${FIELD_LABELS[key as FieldKey] ?? key}: ${String(value).trim()}`,
    )
    .join("; ");
}

function lineItemSummaryForTermsAssessment(doc: CaseDoc) {
  if (!doc.lineItems?.length) return "";
  return doc.lineItems
    .slice(0, 20)
    .map((item, index) =>
      [
        item.lineNumber || `line ${index + 1}`,
        item.itemCode,
        item.description,
        item.quantity && item.unit
          ? `${item.quantity} ${item.unit}`
          : item.quantity,
        item.rate ? `rate ${item.rate}` : "",
        item.taxableAmount ? `taxable ${item.taxableAmount}` : "",
        item.lineTotal ? `total ${item.lineTotal}` : "",
      ]
        .filter(Boolean)
        .join(" | "),
    )
    .join("\n");
}

function buildTermsAssessmentPrompt(documents: CaseDoc[]) {
  return documents
    .map((doc) => {
      const termsFields = getTermsFieldSummary(doc);
      return [
        `DOC_ID: ${doc.id}`,
        `TYPE: ${doc.type}`,
        `TITLE: ${doc.title}`,
        `SOURCE: ${doc.sourceFileName ?? doc.sourceHint ?? "uploaded"}`,
        termsFields.length ? `EXTRACTED_TERMS:\n${termsFields.join("\n")}` : "",
        `FIELDS: ${fieldSummaryForTermsAssessment(doc) || "No extracted fields"}`,
        lineItemSummaryForTermsAssessment(doc)
          ? `LINE_ITEMS:\n${lineItemSummaryForTermsAssessment(doc)}`
          : "",
        `VISIBLE_TEXT:\n${compactPromptText(doc.md ?? "", termsFields.length ? 5000 : 3500)}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n---\n\n")
    .slice(0, 52000);
}

function normalizeTermsStatus(value: unknown) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z_]/g, "");
  if (
    normalized === "notfulfilled" ||
    normalized === "not_fulfilled" ||
    normalized === "failed" ||
    normalized === "breach"
  )
    return "not_fulfilled";
  if (
    normalized === "fulfilled" ||
    normalized === "satisfied" ||
    normalized === "ok"
  )
    return "fulfilled";
  if (
    normalized === "notapplicable" ||
    normalized === "not_applicable" ||
    normalized === "na"
  )
    return "not_applicable";
  if (
    normalized === "unknown" ||
    normalized === "needsreview" ||
    normalized === "insufficientevidence"
  )
    return "unknown";
  return "";
}

function normalizeStringList(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,;\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function stableMismatchPart(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "terms"
  );
}

function normalizeTermsSeverity(value: unknown) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (normalized === "critical") return "high";
  if (normalized === "high" || normalized === "medium" || normalized === "low")
    return normalized;
  return "";
}

function buildTermsComplianceMismatch(
  assessment: TermsComplianceAssessment,
  documentsById: Map<string, CaseDoc>,
  index: number,
): Mismatch | null {
  const sourceDocId = String(assessment.sourceDocId ?? "").trim();
  const sourceDoc = documentsById.get(sourceDocId);
  if (!sourceDoc) return null;

  const status = normalizeTermsStatus(assessment.status);
  if (!isActionableTermsComplianceStatus(status)) return null;

  const sourceClause = compactPromptText(
    String(assessment.sourceClause ?? "").trim(),
    700,
  );
  const obligation = compactPromptText(
    String(assessment.obligation ?? "").trim(),
    500,
  );
  if (!sourceClause || !obligation) return null;

  const reason = compactPromptText(String(assessment.reason ?? "").trim(), 700);
  const evidence = compactPromptText(
    String(assessment.evidence ?? "").trim(),
    700,
  );
  const category = compactPromptText(
    String(assessment.category ?? "Terms compliance").trim(),
    80,
  );
  const evidenceDocIds = normalizeStringList(assessment.evidenceDocIds).filter(
    (docId) => documentsById.has(docId),
  );
  const valueDocIds = [sourceDocId, ...evidenceDocIds].filter(
    (docId, docIndex, ids) => ids.indexOf(docId) === docIndex,
  );
  const statusLabel =
    status === "not_fulfilled" ? "Not fulfilled" : "Needs review";
  const issueValue = [
    `${statusLabel}: ${obligation}`,
    `Clause: ${sourceClause}`,
    reason ? `Reason: ${reason}` : "",
    evidence ? `Evidence: ${evidence}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    id: `${TERMS_COMPLIANCE_MISMATCH_PREFIX}-${stableMismatchPart(sourceDocId)}-${index}-${stableMismatchPart(obligation)}`,
    field: TERMS_COMPLIANCE_FIELD,
    values: valueDocIds.map((docId) => ({
      docId,
      value:
        docId === sourceDocId
          ? issueValue
          : `Evidence reviewed for clause: ${obligation}`,
    })),
    analysis:
      status === "not_fulfilled"
        ? `A terms and conditions obligation is not fulfilled. Source: ${sourceDoc.title}. Category: ${category}. ${reason || evidence || obligation}`
        : `A terms and conditions obligation needs manual review because the packet does not contain enough clear evidence. Source: ${sourceDoc.title}. Category: ${category}. ${reason || obligation}`,
    fixPlan:
      `1. Review the source clause: ${sourceClause}\n` +
      `2. Add or correct the packet evidence needed to satisfy: ${obligation}\n` +
      "3. Re-run analysis so the terms compliance issue can be cleared.",
  };
}

function buildTermsComplianceChecklistItem(
  assessment: TermsComplianceAssessment,
  documentsById: Map<string, CaseDoc>,
): TermsComplianceChecklistItem | null {
  const sourceDocId = String(assessment.sourceDocId ?? "").trim();
  if (!documentsById.has(sourceDocId)) return null;

  const status = normalizeTermsStatus(assessment.status);
  if (!status) return null;

  const sourceClause = compactPromptText(
    String(assessment.sourceClause ?? "").trim(),
    700,
  );
  const obligation = compactPromptText(
    String(assessment.obligation ?? "").trim(),
    500,
  );
  if (!sourceClause || !obligation) return null;

  const severity = normalizeTermsSeverity(assessment.severity) || "none";
  const evidenceDocIds = normalizeStringList(assessment.evidenceDocIds).filter(
    (docId) => documentsById.has(docId),
  );

  return {
    sourceDocId,
    sourceClause,
    obligation,
    category: compactPromptText(
      String(assessment.category ?? "Terms compliance").trim(),
      80,
    ),
    status: status as TermsComplianceChecklistItem["status"],
    evidenceDocIds,
    evidence: compactPromptText(String(assessment.evidence ?? "").trim(), 700),
    reason: compactPromptText(String(assessment.reason ?? "").trim(), 700),
    severity: severity as TermsComplianceChecklistItem["severity"],
  };
}

export function buildAuthoritativeTermsComplianceResult(
  documents: CaseDoc[],
  checklist: TermsComplianceChecklistItem[],
) {
  const documentsById = new Map(documents.map((doc) => [doc.id, doc]));
  const mismatches = checklist
    .map((entry, index) =>
      buildTermsComplianceMismatch(entry, documentsById, index + 1),
    )
    .filter((mismatch): mismatch is Mismatch => Boolean(mismatch))
    .slice(0, 10);
  return { checklist, mismatches };
}

const REQUIRED_PACKET_DOCUMENT_RULES: Array<{
  label: string;
  matchesClause: RegExp;
  matchesType: (type: DocType) => boolean;
}> = [
  {
    label: "material test certificate",
    matchesClause: /\b(?:material|mill)\s+test\s+certificate\b|\bMTC\b/i,
    matchesType: (type) => type === "Material Test Certificate",
  },
  {
    label: "E-Way Bill",
    matchesClause: /\be[ -]?way\s+bill\b/i,
    matchesType: (type) => type === "E-Way Bill",
  },
  {
    label: "lorry receipt",
    matchesClause:
      /\blorry\s+receipt\b|\bconsignment\s+(?:note|receipt)\b|\bLR\b/i,
    matchesType: (type) => type === "Lorry Receipt",
  },
  {
    label: "weighment slip",
    matchesClause: /\b(?:weighment|weight)\s+(?:slip|ticket)\b/i,
    matchesType: (type) => type === "Weighment Slip",
  },
  {
    label: "delivery challan or note",
    matchesClause: /\bdelivery\s+(?:challan|note)\b/i,
    matchesType: (type) =>
      type === "Delivery Challan" || type === "Delivery Note",
  },
];

function getExplicitRequiredDocumentRule(clause: string) {
  const isExplicitRequirement =
    /\b(?:must|shall|required|mandatory|compulsory|needs?\s+to|has\s+to)\b/i.test(
      clause,
    );
  const isConditional =
    /\b(?:if|where|when)\s+(?:applicable|required|available)\b|\bsubject\s+to\b/i.test(
      clause,
    );
  if (!isExplicitRequirement || isConditional) return undefined;

  return REQUIRED_PACKET_DOCUMENT_RULES.find((rule) =>
    rule.matchesClause.test(clause),
  );
}

function appendDeterministicMissingDocumentChecks(
  checklist: TermsComplianceChecklistItem[],
  documents: CaseDoc[],
) {
  const next = [...checklist];
  for (const sourceDoc of documents) {
    const termText = TERMS_FIELD_KEYS.map((field) => sourceDoc.fields[field])
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n");
    const sourceText = termText || getVisibleTextFromMarkdown(sourceDoc.md);
    const clauses = sourceText
      .split(/[;\n]+|(?<=[.!?])\s+/)
      .map((clause) => compactPromptText(clause, 700))
      .filter(Boolean);

    for (const clause of clauses) {
      const requiredDocument = getExplicitRequiredDocumentRule(clause);
      if (
        !requiredDocument ||
        documents.some((doc) => requiredDocument.matchesType(doc.type)) ||
        next.some(
          (item) =>
            item.sourceDocId === sourceDoc.id &&
            requiredDocument.matchesClause.test(
              item.sourceClause + " " + item.obligation,
            ),
        )
      ) {
        continue;
      }

      next.push({
        sourceDocId: sourceDoc.id,
        sourceClause: clause,
        obligation:
          "Include the required " + requiredDocument.label + " in the packet.",
        category: "Document requirement",
        status: "not_fulfilled",
        evidenceDocIds: [],
        evidence: "No matching document was found in the uploaded packet.",
        reason:
          "The clause explicitly requires a " +
          requiredDocument.label +
          ", but the packet does not contain one.",
        severity: "medium",
      });
    }
  }
  return next.slice(0, 30);
}

function enforceExplicitRequiredDocumentChecks(
  checklist: TermsComplianceChecklistItem[],
  documents: CaseDoc[],
) {
  return checklist.map((item) => {
    const clause = item.sourceClause + " " + item.obligation;
    const requiredDocument = getExplicitRequiredDocumentRule(clause);
    if (
      !requiredDocument ||
      documents.some((doc) => requiredDocument.matchesType(doc.type))
    ) {
      return item;
    }

    return {
      ...item,
      status: "not_fulfilled" as const,
      evidenceDocIds: [],
      evidence: "No matching document was found in the uploaded packet.",
      reason:
        "The clause explicitly requires a " +
        requiredDocument.label +
        ", but the packet does not contain one.",
      severity:
        item.severity === "high" ? ("high" as const) : ("medium" as const),
    };
  });
}

export function assessRequiredDocumentCompliance(
  documents: CaseDoc[],
  checklist: TermsComplianceChecklistItem[] = [],
) {
  const documentsById = new Map(documents.map((doc) => [doc.id, doc]));
  const finalChecklist = enforceExplicitRequiredDocumentChecks(
    appendDeterministicMissingDocumentChecks(checklist, documents),
    documents,
  );
  const mismatches = finalChecklist
    .map((entry, index) =>
      buildTermsComplianceMismatch(entry, documentsById, index + 1),
    )
    .filter((mismatch): mismatch is Mismatch => Boolean(mismatch))
    .slice(0, 10);
  return { checklist: finalChecklist, mismatches };
}

export async function assessCaseTermsComplianceDetailed(
  documents: CaseDoc[],
): Promise<{
  mismatches: Mismatch[];
  checklist: TermsComplianceChecklistItem[];
}> {
  const assessableDocuments = documents.filter(
    (doc) =>
      doc.md?.trim() ||
      Object.values(doc.fields).some(
        (value) =>
          value !== undefined && value !== null && String(value).trim(),
      ) ||
      Boolean(doc.lineItems?.length),
  );
  if (!assessableDocuments.length) return { mismatches: [], checklist: [] };

  const hasExplicitTerms = assessableDocuments.some((doc) => {
    if (TERMS_FIELD_KEYS.some((field) => Boolean(doc.fields[field]?.trim()))) {
      return true;
    }
    const visibleText = getVisibleTextFromMarkdown(doc.md);
    return /\b(?:terms?\s*(?:&|and)\s*conditions?|payment\s+terms?|delivery\s+terms?|freight\s+terms?|commercial\s+terms?|special\s+terms?|warranty|guarantee|inspection\s+terms?)\b/i.test(
      visibleText,
    );
  });
  if (!hasExplicitTerms) return { mismatches: [], checklist: [] };

  const documentsById = new Map(
    assessableDocuments.map((doc) => [doc.id, doc]),
  );
  const packetContext = buildTermsAssessmentPrompt(assessableDocuments);
  if (!packetContext.trim()) return { mismatches: [], checklist: [] };

  let raw = "";
  try {
    raw = await callOpenRouter(
      [
        {
          role: "system",
          content:
            "You assess procurement packet terms and conditions compliance. Return only JSON with key obligations. " +
            "Terms can appear in any document type, not only purchase orders. Use only explicit visible clauses and packet evidence. " +
            'First identify whether the packet contains any explicit terms, conditions, commercial clauses, special instructions, or document requirements. If not, return {"obligations":[]}. ' +
            "Do not compare wording between documents. Convert each explicit clause into a checkable obligation only when it can be assessed from the uploaded packet. " +
            "Statuses must be one of fulfilled, not_fulfilled, unknown, not_applicable. " +
            "Use not_fulfilled only when packet evidence clearly violates or misses a required obligation. Use unknown when the obligation is material but evidence is insufficient. " +
            "Use not_applicable for generic legal boilerplate, jurisdiction, future warranty/interest clauses, or clauses not testable from current packet evidence. " +
            "For conditional clauses like 'if applicable', do not mark not_fulfilled unless applicability is clear from the packet. " +
            "Unknown means manual review only; it must stay in the checklist and must not be treated as a mismatch or rejection. " +
            "Set severity to high, medium, low, or none. Use high/medium only for obligations that can block packet approval. " +
            "Each obligation object must include sourceDocId, sourceClause, obligation, category, status, evidenceDocIds, evidence, reason, severity.",
        },
        {
          role: "user",
          content:
            'Assess this packet. Return JSON like {"obligations":[...]} and keep only concise evidence from the packet.\n\n' +
            packetContext,
        },
      ],
      {
        expectJson: true,
        model: getQualityExtractionModel(),
        reasoning:
          PACKET_TERMS_REASONING_TOKENS > 0
            ? { max_tokens: PACKET_TERMS_REASONING_TOKENS, exclude: true }
            : undefined,
        maxTokens: PACKET_TERMS_MAX_OUTPUT_TOKENS,
        operation: "terms-compliance",
      },
    );
  } catch (error) {
    console.warn("Failed to assess terms compliance", error);
    // Deterministic required-document checks below still run when the model is
    // unavailable. A mandatory attachment must not disappear with an AI call.
  }

  const parsed = safeJsonParse<{ obligations?: unknown }>(raw, {});
  const obligations = Array.isArray(parsed.obligations)
    ? parsed.obligations
    : [];
  const modelChecklist = obligations
    .map((entry) =>
      buildTermsComplianceChecklistItem(
        entry as TermsComplianceAssessment,
        documentsById,
      ),
    )
    .filter((entry): entry is TermsComplianceChecklistItem => Boolean(entry))
    .slice(0, 30);
  return assessRequiredDocumentCompliance(assessableDocuments, modelChecklist);
}

export async function assessCaseTermsCompliance(
  documents: CaseDoc[],
): Promise<Mismatch[]> {
  const result = await assessCaseTermsComplianceDetailed(documents);
  return result.mismatches;
}

type ExtractionReviewCorrection = {
  docId?: unknown;
  documentType?: unknown;
  fields?: unknown;
  unsetFields?: unknown;
  quarantineFields?: unknown;
  lineItems?: unknown;
  evidence?: unknown;
  reason?: unknown;
};

type ExtractionReviewPayload = {
  verdict?: unknown;
  corrections?: unknown;
  reviewIssues?: unknown;
  documentAudits?: unknown;
  sourceSupport?: unknown;
  referenceReviews?: unknown;
  mismatchDecisions?: unknown;
  termsChecklist?: unknown;
  packetGroups?: unknown;
  pageQuality?: unknown;
  notes?: unknown;
};

const REVIEW_LINE_ITEM_PROPERTY_KEYS = [
  "lineNumber",
  "itemCode",
  "description",
  "hsnSac",
  "quantity",
  "unit",
  "rate",
  "discountPercent",
  "netRate",
  "taxableAmount",
  "cgstRate",
  "cgstAmount",
  "sgstRate",
  "sgstAmount",
  "igstRate",
  "igstAmount",
  "taxRate",
  "taxAmount",
  "lineTotal",
  "referencePoLineNumber",
  "rawText",
] as const;

type ReviewLineItemProperty = (typeof REVIEW_LINE_ITEM_PROPERTY_KEYS)[number];
const REVIEW_LINE_ITEM_PROPERTY_KEY_SET = new Set<string>(
  REVIEW_LINE_ITEM_PROPERTY_KEYS,
);

// The review prompt still contains the semantic rules and the parsers below
// remain the final validation boundary. Constrain every nested review object
// as well as the top level: an open `{ type: "object" }` item lets a provider
// generate arbitrarily large objects even though the required decision is
// small. Counts tied to the actual request also prevent duplicate decisions.
export function buildReviewSourceSupportChecklist(documents: CaseDoc[]) {
  return Object.fromEntries(
    documents.map((document) => [
      document.id,
      {
        fieldSupport: Object.keys(document.fields).filter(
          (key) =>
            isKnownFieldKey(key) &&
            !REFERENCE_FIELD_KEYS.has(key) &&
            String(document.fields[key] ?? "").trim(),
        ),
        lineItemPropertySupport: [
          ...new Set(
            (document.lineItems ?? []).flatMap((item) =>
              Object.keys(item).filter(
                (key) =>
                  REVIEW_LINE_ITEM_PROPERTY_KEY_SET.has(key) &&
                  String(item[key as ReviewLineItemProperty] ?? "").trim(),
              ),
            ),
          ),
        ],
      },
    ]),
  );
}

export function buildAuthoritativeReviewResponseSchema(input: {
  documentCount: number;
  mismatchCount: number;
  pageCount: number;
  documents?: CaseDoc[];
}) {
  const conciseString = (maxLength = 700) => ({
    type: "string",
    maxLength,
  });
  const stringArray = (maxItems: number, maxLength = 180) => ({
    type: "array",
    maxItems,
    items: conciseString(maxLength),
  });
  const exactArray = (count: number, items: Record<string, unknown>) => ({
    type: "array",
    minItems: count,
    maxItems: count,
    items,
  });
  const evidence = {
    type: "object",
    properties: {
      sourceFileName: conciseString(240),
      pageNumber: { type: "integer", minimum: 1, maximum: 40 },
      quote: conciseString(300),
    },
    required: ["sourceFileName", "pageNumber", "quote"],
    additionalProperties: false,
  };
  const lineItemProperties = Object.fromEntries(
    REVIEW_LINE_ITEM_PROPERTY_KEYS.map((key) => [
      key,
      conciseString(key === "rawText" ? 500 : 240),
    ]),
  );
  const fieldChange = {
    type: "object",
    properties: {
      field: { type: "string", enum: ALL_ALLOWED_FIELD_KEYS },
      value: {
        anyOf: [conciseString(1200), { type: "null" }],
      },
    },
    required: ["field", "value"],
    additionalProperties: false,
  };
  const correction = {
    type: "object",
    properties: {
      docId: conciseString(120),
      documentType: { type: "string", enum: SUPPORTED_DOC_TYPES },
      fields: {
        type: "array",
        maxItems: ALL_ALLOWED_FIELD_KEYS.length,
        items: fieldChange,
      },
      unsetFields: {
        type: "array",
        maxItems: ALL_ALLOWED_FIELD_KEYS.length,
        uniqueItems: true,
        items: { type: "string", enum: ALL_ALLOWED_FIELD_KEYS },
      },
      quarantineFields: {
        type: "array",
        maxItems: ALL_ALLOWED_FIELD_KEYS.length,
        items: {
          type: "object",
          properties: {
            field: { type: "string", enum: ALL_ALLOWED_FIELD_KEYS },
            reason: conciseString(400),
          },
          required: ["field", "reason"],
          additionalProperties: false,
        },
      },
      lineItems: {
        type: "array",
        maxItems: 200,
        items: {
          type: "object",
          properties: {
            ...lineItemProperties,
            sourcePage: { type: "integer", minimum: 1, maximum: 40 },
          },
          additionalProperties: false,
        },
      },
      evidence,
      reason: conciseString(500),
    },
    required: ["docId", "evidence", "reason"],
    additionalProperties: false,
  };
  const reviewIssue = {
    type: "object",
    properties: {
      field: conciseString(120),
      evidence: {
        type: "array",
        minItems: 1,
        maxItems: Math.max(1, input.documentCount),
        items: {
          type: "object",
          properties: {
            docId: conciseString(120),
            value: conciseString(500),
          },
          required: ["docId", "value"],
          additionalProperties: false,
        },
      },
      reason: conciseString(700),
    },
    required: ["field", "evidence", "reason"],
    additionalProperties: false,
  };
  const documentAudit = {
    type: "object",
    properties: {
      docId: conciseString(120),
      status: {
        type: "string",
        enum: ["verified", "corrected", "needs_review"],
      },
      unsupportedFields: {
        type: "array",
        maxItems: ALL_ALLOWED_FIELD_KEYS.length,
        uniqueItems: true,
        items: { type: "string", enum: ALL_ALLOWED_FIELD_KEYS },
      },
      supportedFields: {
        type: "array",
        maxItems: ALL_ALLOWED_FIELD_KEYS.length,
        uniqueItems: true,
        items: { type: "string", enum: ALL_ALLOWED_FIELD_KEYS },
      },
      visibleOmittedFields: {
        type: "array",
        maxItems: ALL_ALLOWED_FIELD_KEYS.length,
        description:
          "Only populated values visibly printed on this document that extraction omitted. Never include a blank, absent or unreadable source value.",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            value: conciseString(1200),
            evidence,
          },
          required: ["field", "value", "evidence"],
          additionalProperties: false,
        },
      },
      unsupportedLineItemProperties: {
        type: "array",
        maxItems: REVIEW_LINE_ITEM_PROPERTY_KEYS.length,
        uniqueItems: true,
        items: { type: "string", enum: REVIEW_LINE_ITEM_PROPERTY_KEYS },
      },
      supportedLineItemProperties: {
        type: "array",
        maxItems: REVIEW_LINE_ITEM_PROPERTY_KEYS.length,
        uniqueItems: true,
        items: { type: "string", enum: REVIEW_LINE_ITEM_PROPERTY_KEYS },
      },
      reason: conciseString(500),
      referenceEvidence: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            value: conciseString(240),
            sourceLabel: conciseString(120),
            valueKind: {
              type: "string",
              enum: ["reference", "document_type", "date", "party", "other"],
            },
            sourceFileName: conciseString(240),
            pageNumber: { type: "integer", minimum: 1, maximum: 40 },
            quote: conciseString(400),
          },
          required: [
            "field",
            "value",
            "sourceLabel",
            "valueKind",
            "sourceFileName",
            "pageNumber",
            "quote",
          ],
          additionalProperties: false,
        },
      },
    },
    required: [
      "docId",
      "status",
      "supportedFields",
      "unsupportedFields",
      "visibleOmittedFields",
      "supportedLineItemProperties",
      "unsupportedLineItemProperties",
      "reason",
      "referenceEvidence",
    ],
    additionalProperties: false,
  };
  // Generate a closed checklist from the untrusted extraction, not a fixed
  // document template. Every original populated field gets exactly one AI
  // verdict; absent fields cannot accidentally enter the support checklist.
  const supportMap = (keys: string[]) => ({
    type: "object",
    properties: Object.fromEntries(
      keys.map((key) => [
        key,
        { type: "string", enum: ["supported", "unsupported"] },
      ]),
    ),
    required: keys,
    additionalProperties: false,
  });
  const keyedSupportProperties = new Set([
    "supportedFields",
    "unsupportedFields",
    "supportedLineItemProperties",
    "unsupportedLineItemProperties",
    "status",
    "referenceEvidence",
  ]);
  const supportChecklist = buildReviewSourceSupportChecklist(
    input.documents ?? [],
  );
  const sourceSupport = input.documents?.length
    ? {
        type: "object",
        properties: Object.fromEntries(
          input.documents.map((document) => [
            document.id,
            {
              type: "object",
              properties: {
                fieldSupport: supportMap(
                  supportChecklist[document.id].fieldSupport,
                ),
                lineItemPropertySupport: supportMap(
                  supportChecklist[document.id].lineItemPropertySupport,
                ),
              },
              required: ["fieldSupport", "lineItemPropertySupport"],
              additionalProperties: false,
            },
          ]),
        ),
        required: input.documents.map((document) => document.id),
        additionalProperties: false,
      }
    : undefined;
  const exactDocumentAudit = sourceSupport
    ? {
        ...documentAudit,
        properties: Object.fromEntries(
          Object.entries(documentAudit.properties).filter(
            ([key]) => !keyedSupportProperties.has(key),
          ),
        ),
        // Readability is the AI judgment; corrected/verified is mechanically
        // derived from its validated mutations, not a second competing vote.
        ...(sourceSupport
          ? {
              properties: {
                ...Object.fromEntries(
                  Object.entries(documentAudit.properties).filter(
                    ([key]) => !keyedSupportProperties.has(key),
                  ),
                ),
                sourceVerdict: {
                  type: "string",
                  enum: ["verified", "needs_review"],
                },
              },
            }
          : {}),
        required: [
          ...documentAudit.required.filter(
            (key) => !keyedSupportProperties.has(key),
          ),
          "sourceVerdict",
        ],
      }
    : documentAudit;
  const mismatchDecision = {
    type: "object",
    properties: {
      mismatchId: conciseString(160),
      status: {
        type: "string",
        enum: ["confirmed", "dismissed"],
      },
      primary: { type: "boolean" },
      outlierDocumentIds: {
        ...stringArray(Math.max(1, input.documentCount), 120),
        uniqueItems: true,
      },
      reason: conciseString(700),
    },
    required: [
      "mismatchId",
      "status",
      "primary",
      "outlierDocumentIds",
      "reason",
    ],
    additionalProperties: false,
  };
  const termsItem = {
    type: "object",
    properties: {
      sourceDocId: conciseString(120),
      sourceClause: conciseString(900),
      obligation: conciseString(700),
      category: conciseString(160),
      status: {
        type: "string",
        enum: ["fulfilled", "not_fulfilled", "unknown", "not_applicable"],
      },
      evidenceDocIds: stringArray(Math.max(1, input.documentCount), 120),
      evidence: conciseString(700),
      reason: conciseString(700),
      severity: {
        type: "string",
        enum: ["high", "medium", "low", "none"],
      },
    },
    required: [
      "sourceDocId",
      "sourceClause",
      "obligation",
      "category",
      "status",
      "evidenceDocIds",
      "evidence",
      "reason",
      "severity",
    ],
    additionalProperties: false,
  };
  const packetGroup = {
    type: "object",
    properties: {
      label: conciseString(160),
      documentIds: {
        ...stringArray(Math.max(1, input.documentCount), 120),
        minItems: 1,
        uniqueItems: true,
      },
      relationship: {
        type: "string",
        enum: ["standard", "seller_chain"],
      },
      primaryDocumentIds: stringArray(Math.max(1, input.documentCount), 120),
      contextDocumentIds: stringArray(Math.max(1, input.documentCount), 120),
      rationale: conciseString(700),
      caseSummary: {
        type: "object",
        properties: {
          ...(!sourceSupport ? { counterpartyName: conciseString(180) } : {}),
          poNumber: conciseString(120),
          invoiceNumber: conciseString(120),
          primaryReference: conciseString(120),
          packetCategory: conciseString(120),
          counterpartySource: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                properties: {
                  docId: conciseString(120),
                  field: { type: "string", enum: COUNTERPARTY_SOURCE_FIELDS },
                },
                required: ["docId", "field"],
                additionalProperties: false,
              },
            ],
          },
        },
        required: [
          ...(!sourceSupport ? ["counterpartyName"] : []),
          "poNumber",
          "invoiceNumber",
          "primaryReference",
          "packetCategory",
          "counterpartySource",
        ],
        additionalProperties: false,
      },
    },
    required: [
      "label",
      "documentIds",
      "relationship",
      "primaryDocumentIds",
      "contextDocumentIds",
      "rationale",
      "caseSummary",
    ],
    additionalProperties: false,
  };
  const pageQuality = {
    type: "object",
    properties: {
      sourceFileName: conciseString(240),
      pageNumber: { type: "integer", minimum: 1, maximum: 40 },
      documentId: conciseString(120),
      issues: {
        type: "array",
        maxItems: 5,
        uniqueItems: true,
        items: {
          type: "string",
          enum: ["faint", "rotated", "blurred", "cropped", "unreadable"],
        },
      },
      approvalSafe: { type: "boolean" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      reason: conciseString(500),
    },
    required: [
      "sourceFileName",
      "pageNumber",
      "documentId",
      "issues",
      "approvalSafe",
      "confidence",
      "reason",
    ],
    additionalProperties: false,
  };

  return compactReviewProviderSchema(
    {
      type: "object",
      properties: {
        ...(!sourceSupport
          ? {
              verdict: {
                type: "string",
                enum: ["pass", "corrected", "needs_review"],
              },
            }
          : {}),
        ...(sourceSupport
          ? {
              referenceReviews: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    docId: conciseString(120),
                    fields: {
                      type: "object",
                      additionalProperties: {
                        type: "object",
                        properties: {
                          value: {
                            anyOf: [{ type: "string" }, { type: "null" }],
                          },
                          sourceLabel: conciseString(120),
                          valueKind: {
                            type: "string",
                            enum: [
                              "reference",
                              "document_type",
                              "date",
                              "party",
                              "other",
                              "absent",
                              "unreadable",
                            ],
                          },
                          sourceFileName: conciseString(240),
                          pageNumber: {
                            type: "integer",
                            minimum: 1,
                            maximum: 40,
                          },
                          quote: conciseString(400),
                        },
                        required: [
                          "value",
                          "sourceLabel",
                          "valueKind",
                          "sourceFileName",
                          "pageNumber",
                          "quote",
                        ],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ["docId", "fields"],
                  additionalProperties: false,
                },
              },
            }
          : {}),
        corrections: {
          type: "array",
          maxItems: input.documentCount,
          items: correction,
        },
        reviewIssues: {
          type: "array",
          maxItems: input.documentCount + input.mismatchCount + input.pageCount,
          items: reviewIssue,
        },
        documentAudits: exactArray(input.documentCount, exactDocumentAudit),
        ...(sourceSupport ? { sourceSupport } : {}),
        mismatchDecisions: exactArray(input.mismatchCount, mismatchDecision),
        termsChecklist: { type: "array", maxItems: 30, items: termsItem },
        packetGroups: {
          type: "array",
          minItems: 1,
          maxItems: Math.max(1, input.documentCount),
          items: packetGroup,
        },
        pageQuality: exactArray(input.pageCount, pageQuality),
        notes: stringArray(10, 500),
      },
      required: [
        ...(!sourceSupport ? ["verdict"] : ["referenceReviews"]),
        "corrections",
        "reviewIssues",
        "documentAudits",
        ...(sourceSupport ? ["sourceSupport"] : []),
        "mismatchDecisions",
        "termsChecklist",
        "packetGroups",
        "pageQuality",
        "notes",
      ],
      additionalProperties: false,
    } satisfies Record<string, unknown>,
    ALL_ALLOWED_FIELD_KEYS,
  );
}

const INDEPENDENT_REVIEW_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    correctionDecisions: { type: "array", items: { type: "object" } },
    reviewIssueDecisions: { type: "array", items: { type: "object" } },
    pageQuality: { type: "array", items: { type: "object" } },
  },
  required: ["correctionDecisions", "reviewIssueDecisions", "pageQuality"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

type ExtractionReviewVerdict = "pass" | "corrected" | "needs_review";

export type ExtractionReviewSummary = {
  enabled: boolean;
  required?: boolean;
  verdict?: ExtractionReviewVerdict;
  attemptCount?: number;
  reviewedAt?: string;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  correctionCount: number;
  reviewIssueCount: number;
  authoritative?: boolean;
  semanticPostProcessing?: boolean;
  candidateMismatchCount?: number;
  confirmedMismatchCount?: number;
  dismissedMismatchCount?: number;
  termsChecklistCount?: number;
  packetGroupCount?: number;
  proposedCorrectionMutationCount?: number;
  verifiedCorrectionMutationCount?: number;
  rejectedCorrectionMutationCount?: number;
  unresolvedCorrectionMutationCount?: number;
  proposedReviewIssueCount?: number;
  verifiedReviewIssueCount?: number;
  dismissedReviewIssueCount?: number;
  unresolvedReviewIssueCount?: number;
  independentPageQualityReview?: boolean;
  executionMode?: "staged";
  sourceReviewCount?: number;
  resumedCheckpointCount?: number;
  decisionBatchCount?: number;
  documentAudits?: AuthoritativeDocumentAudit[];
  corrections: Array<{
    docId: string;
    title: string;
    reason?: string;
    changedFields: string[];
    unsetFields: string[];
    quarantinedFields: string[];
    documentType?: string;
    lineItemsReplaced?: boolean;
  }>;
  warnings: string[];
  error?: string;
};

type AuthoritativeMismatchDecision = {
  mismatchId: string;
  status: "confirmed" | "dismissed";
  primary: boolean;
  outlierDocumentIds: string[];
  reason: string;
};

function authoritativeMismatchReviewId(index: number) {
  return `mismatch-${index + 1}`;
}

export type AuthoritativeCaseSummary = {
  counterpartyName: string;
  poNumber: string;
  invoiceNumber: string;
  primaryReference: string;
  packetCategory: string;
  counterpartySource: CounterpartySource | null;
};

export type AuthoritativePacketReviewGroup = VerificationGroup & {
  caseSummary: AuthoritativeCaseSummary;
};

export type AuthoritativeDocumentAudit = {
  docId: string;
  status: "verified" | "corrected" | "needs_review";
  supportedFields: FieldKey[];
  unsupportedFields: FieldKey[];
  visibleOmittedFields: Array<{ field: FieldKey; value: string }>;
  supportedLineItemProperties: ReviewLineItemProperty[];
  unsupportedLineItemProperties: ReviewLineItemProperty[];
  reason: string;
  referenceEvidence: ReferenceGrounding[];
  fieldEvidence?: Array<{
    field: FieldKey;
    value: string;
    evidenceKind?: "printed" | "visual_observation";
    evidence: { sourceFileName: string; pageNumber: number; quote: string };
  }>;
};

export type ReviewSourcePage = {
  sourceFileName: string;
  pageNumber: number;
  image: string;
};

export type AuthoritativeReviewResult = {
  mismatches: Mismatch[];
  termsChecklist: TermsComplianceChecklistItem[];
  verificationGroups: AuthoritativePacketReviewGroup[];
  documentAudits: AuthoritativeDocumentAudit[];
};

type CorrectionMutationKind =
  "documentType" | "field" | "unsetField" | "quarantineField" | "lineItems";

type CorrectionMutationCandidate = {
  id: string;
  correctionIndex: number;
  docId: string;
  documentTitle: string;
  kind: CorrectionMutationKind;
  field?: string;
  currentValue: unknown;
  proposedValue: unknown;
  reviewerReason: string;
  reviewerEvidence: unknown;
};

type CorrectionMutationDecision = {
  mutationId: string;
  verdict: "accept" | "keep_original" | "needs_review";
  reason: string;
  evidence: {
    sourceFileName: string;
    pageNumber: number;
    quote: string;
  };
};

type IndependentReviewIssueDecision = {
  reviewIssueId: string;
  verdict: "confirmed" | "dismissed" | "needs_review";
  reason: string;
};

type IndependentReviewValidation = {
  corrections: unknown[];
  pageQuality: DocumentPageQualityAssessment[];
  reviewIssues: Mismatch[];
  proposedCount: number;
  verifiedCount: number;
  rejectedCount: number;
  unresolvedCount: number;
  proposedReviewIssueCount: number;
  verifiedReviewIssueCount: number;
  dismissedReviewIssueCount: number;
  unresolvedReviewIssueCount: number;
  warnings: string[];
};

function materializeReferenceLedgerReview(
  payload: ExtractionReviewPayload,
  documents: CaseDoc[],
  sourcePages: ReviewSourcePage[],
) {
  if (!Array.isArray(payload.referenceReviews))
    throw new Error("Missing referenceReviews value-and-proof ledger.");
  const ledgers = new Map<string, ReturnType<typeof readReferenceLedger>>();
  for (const raw of payload.referenceReviews) {
    const entry = readObjectRecord(raw);
    const docId = String(entry?.docId ?? "");
    const document = documents.find((doc) => doc.id === docId);
    if (!document || ledgers.has(docId))
      throw new Error(
        `Duplicate or unknown reference ledger document: ${docId}.`,
      );
    ledgers.set(
      docId,
      readReferenceLedger({ document, fields: entry?.fields, sourcePages }),
    );
  }
  if (ledgers.size !== documents.length)
    throw new Error(
      "Reference ledgers must cover every document exactly once.",
    );
  const corrections = Array.isArray(payload.corrections)
    ? [...payload.corrections]
    : [];
  const support = readObjectRecord(payload.sourceSupport);
  if (!support)
    throw new Error("Missing sourceSupport for non-reference fields.");
  const audits = Array.isArray(payload.documentAudits)
    ? payload.documentAudits
    : [];
  for (const document of documents) {
    const ledger = ledgers.get(document.id)!;
    const audit = audits
      .map(readObjectRecord)
      .find((entry) => entry?.docId === document.id);
    const docSupport = readObjectRecord(support[document.id]);
    const fieldsSupport = readObjectRecord(docSupport?.fieldSupport);
    if (!audit || !fieldsSupport)
      throw new Error(`Missing audit or field support for ${document.id}.`);
    // References are decided once in their ledger. The canonical field-support
    // view is derived from those same entries, not a second model decision.
    Object.assign(fieldsSupport, ledger.originalSupport);
    if (ledger.hasUnresolvedSource) audit.sourceVerdict = "needs_review";
    audit.referenceEvidence = ledger.proofs;
    const matching = corrections
      .map(readObjectRecord)
      .filter((entry) => entry?.docId === document.id);
    if (matching.length > 1)
      throw new Error(`Duplicate corrections on ${document.id}.`);
    let correction = matching[0];
    if (correction) {
      const fields = readCorrectionFields(correction.fields) ?? {};
      for (const [field, value] of Object.entries(fields)) {
        if (!isKnownFieldKey(field) || !REFERENCE_FIELD_KEYS.has(field))
          continue;
        if (value !== (ledger.finalFields[field] ?? null))
          throw new Error(
            `The correction contradicts its reference ledger on ${document.id}: ${field}.`,
          );
        delete fields[field];
      }
      correction.fields = Object.entries(fields).map(([field, value]) => ({
        field,
        value,
      }));
      for (const key of ["unsetFields", "quarantineFields"]) {
        if (!Array.isArray(correction[key])) continue;
        correction[key] = correction[key].filter((raw) => {
          const field =
            typeof raw === "string" ? raw : readObjectRecord(raw)?.field;
          if (!isKnownFieldKey(field) || !REFERENCE_FIELD_KEYS.has(field))
            return true;
          if (ledger.finalFields[field])
            throw new Error(
              `Reference removal contradicts the ledger on ${document.id}: ${field}.`,
            );
          return false;
        });
      }
    }
    if (ledger.changes.length) {
      if (!correction) {
        correction = {
          docId: document.id,
          fields: [],
          evidence: ledger.changes[0].evidence,
          reason: "Source-grounded reference ledger changes.",
        };
        corrections.push(correction);
      }
      correction.fields = [
        ...(Array.isArray(correction.fields) ? correction.fields : []),
        ...ledger.changes.map(({ field, value }) => ({ field, value })),
      ];
      const omissions = Array.isArray(audit.visibleOmittedFields)
        ? audit.visibleOmittedFields
        : [];
      for (const change of ledger.changes) {
        if (
          !document.fields[change.field] &&
          change.value !== null &&
          !omissions.some(
            (item) => readObjectRecord(item)?.field === change.field,
          )
        ) {
          omissions.push({
            field: change.field,
            value: change.value,
            evidence: change.evidence,
          });
        }
      }
      audit.visibleOmittedFields = omissions;
    }
  }
  payload.corrections = corrections;
  const needsReview =
    audits.some(
      (raw) => readObjectRecord(raw)?.sourceVerdict === "needs_review",
    ) ||
    (Array.isArray(payload.reviewIssues) && payload.reviewIssues.length > 0) ||
    (Array.isArray(payload.mismatchDecisions) &&
      payload.mismatchDecisions.some(
        (raw) => readObjectRecord(raw)?.status === "confirmed",
      )) ||
    (Array.isArray(payload.termsChecklist) &&
      payload.termsChecklist.some(
        (raw) => readObjectRecord(raw)?.status === "not_fulfilled",
      )) ||
    (Array.isArray(payload.pageQuality) &&
      payload.pageQuality.some(
        (raw) => readObjectRecord(raw)?.approvalSafe === false,
      ));
  payload.verdict = needsReview
    ? "needs_review"
    : buildCorrectionMutationCandidates(payload, documents).length
      ? "corrected"
      : "pass";
}

function parseExtractionReviewPayload(
  raw: string,
  authoritative = false,
  documents?: CaseDoc[],
  sourcePages: ReviewSourcePage[] = [],
): ExtractionReviewPayload & {
  verdict: ExtractionReviewVerdict;
  corrections: unknown[];
  reviewIssues: unknown[];
} {
  const payload = safeJsonParse<ExtractionReviewPayload | null>(raw, null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("The extraction reviewer did not return a JSON object.");
  }
  if (authoritative && documents && payload.referenceReviews !== undefined) {
    materializeReferenceLedgerReview(payload, documents, sourcePages);
  }

  const verdict = String(payload.verdict ?? "").trim();
  if (!(["pass", "corrected", "needs_review"] as string[]).includes(verdict)) {
    throw new Error("The extraction reviewer did not return a valid verdict.");
  }
  if (
    !Array.isArray(payload.corrections) ||
    !Array.isArray(payload.reviewIssues)
  ) {
    throw new Error(
      "The extraction reviewer response is missing corrections or reviewIssues.",
    );
  }
  if (
    verdict === "pass" &&
    ((documents
      ? buildCorrectionMutationCandidates(payload, documents).length > 0
      : payload.corrections.length > 0) ||
      payload.reviewIssues.length > 0)
  ) {
    throw new Error(
      "The extraction reviewer returned a pass verdict with unresolved changes.",
    );
  }
  if (verdict === "corrected" && payload.corrections.length === 0) {
    throw new Error(
      "The extraction reviewer returned a corrected verdict without a correction.",
    );
  }
  if (
    verdict === "needs_review" &&
    payload.reviewIssues.length === 0 &&
    !authoritative
  ) {
    throw new Error(
      "The extraction reviewer returned a needs_review verdict without evidence.",
    );
  }

  return {
    ...payload,
    verdict: verdict as ExtractionReviewVerdict,
    corrections: payload.corrections,
    reviewIssues: payload.reviewIssues,
  };
}

function parseAuthoritativeMismatchDecisions(
  value: unknown,
  candidates: Mismatch[],
) {
  if (!Array.isArray(value)) {
    throw new Error(
      "The authoritative reviewer response is missing mismatchDecisions.",
    );
  }

  const candidatesByReviewId = new Map(
    candidates.map((item, index) => [
      authoritativeMismatchReviewId(index),
      item,
    ]),
  );
  const decisions = new Map<string, AuthoritativeMismatchDecision>();
  for (const rawDecision of value) {
    if (
      !rawDecision ||
      typeof rawDecision !== "object" ||
      Array.isArray(rawDecision)
    ) {
      throw new Error(
        "The authoritative reviewer returned a malformed mismatch decision.",
      );
    }
    const record = rawDecision as Record<string, unknown>;
    const reviewId = String(record.mismatchId ?? "").trim();
    const status = String(record.status ?? "").trim();
    const primary = record.primary === true;
    const outlierDocumentIds = Array.isArray(record.outlierDocumentIds)
      ? [
          ...new Set(
            record.outlierDocumentIds
              .map((docId) => String(docId ?? "").trim())
              .filter(Boolean),
          ),
        ]
      : [];
    const reason = compactPromptText(String(record.reason ?? "").trim(), 700);
    const candidate = candidatesByReviewId.get(reviewId);
    if (!candidate) {
      throw new Error(
        `The authoritative reviewer referenced an unknown mismatch: ${reviewId || "<missing>"}.`,
      );
    }
    if (decisions.has(candidate.id)) {
      throw new Error(
        `The authoritative reviewer returned duplicate decisions for ${reviewId}.`,
      );
    }
    if (!(["confirmed", "dismissed"] as string[]).includes(status)) {
      throw new Error(
        `The authoritative reviewer returned an invalid status for ${reviewId}.`,
      );
    }
    if (!reason) {
      throw new Error(
        `The authoritative reviewer did not explain its decision for ${reviewId}.`,
      );
    }
    const candidateDocumentIds = new Set(
      candidate.values.map((entry) => entry.docId).filter(Boolean),
    );
    const invalidOutlierDocumentIds = outlierDocumentIds.filter(
      (docId) => !candidateDocumentIds.has(docId),
    );
    if (invalidOutlierDocumentIds.length) {
      throw new Error(
        `The authoritative reviewer attributed ${reviewId} to documents outside its evidence: ${invalidOutlierDocumentIds.join(", ")}.`,
      );
    }
    decisions.set(candidate.id, {
      mismatchId: candidate.id,
      status: status as AuthoritativeMismatchDecision["status"],
      primary,
      outlierDocumentIds,
      reason,
    });
  }

  if (decisions.size !== candidates.length) {
    const missing = candidates
      .map((candidate, index) => ({
        candidate,
        reviewId: authoritativeMismatchReviewId(index),
      }))
      .filter(({ candidate }) => !decisions.has(candidate.id))
      .map(({ reviewId }) => reviewId);
    throw new Error(
      `The authoritative reviewer did not decide every candidate mismatch: ${missing.join(", ") || "count mismatch"}.`,
    );
  }

  const mismatches = candidates
    .flatMap((candidate, candidateIndex) => {
      const decision = decisions.get(candidate.id);
      if (!decision || decision.status !== "confirmed") return [];
      const attributedValues = decision.outlierDocumentIds.length
        ? candidate.values.map((entry) => ({
            ...entry,
            isOutlier: decision.outlierDocumentIds.includes(entry.docId),
          }))
        : candidate.values;
      return [
        {
          mismatch: {
            ...candidate,
            values: attributedValues,
            analysis: `Authoritative packet review: ${decision.reason}`,
          },
          primary: decision.primary,
          candidateIndex,
        },
      ];
    })
    .sort(
      (left, right) =>
        Number(right.primary) - Number(left.primary) ||
        left.candidateIndex - right.candidateIndex,
    )
    .map((entry) => entry.mismatch);

  return {
    decisions: [...decisions.values()],
    mismatches,
    confirmedCount: [...decisions.values()].filter(
      (decision) => decision.status === "confirmed",
    ).length,
    dismissedCount: [...decisions.values()].filter(
      (decision) => decision.status === "dismissed",
    ).length,
  };
}

function parseAuthoritativeTermsChecklist(
  value: unknown,
  documents: CaseDoc[],
) {
  if (!Array.isArray(value)) {
    throw new Error(
      "The authoritative reviewer response is missing termsChecklist.",
    );
  }
  const documentsById = new Map(documents.map((doc) => [doc.id, doc]));
  return value.map((entry, index) => {
    const item = buildTermsComplianceChecklistItem(
      entry as TermsComplianceAssessment,
      documentsById,
    );
    if (!item) {
      throw new Error(
        `The authoritative reviewer returned an invalid terms item at position ${index + 1}.`,
      );
    }
    return item;
  });
}

function parseAuthoritativePacketGroups(
  value: unknown,
  documents: CaseDoc[],
  sourceNamedSummary = false,
) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      "The authoritative reviewer response is missing packetGroups.",
    );
  }

  const documentsById = new Map(documents.map((doc) => [doc.id, doc]));
  const assignedDocumentIds = new Set<string>();
  const groups = value.map(
    (rawGroup, index): AuthoritativePacketReviewGroup => {
      if (
        !rawGroup ||
        typeof rawGroup !== "object" ||
        Array.isArray(rawGroup)
      ) {
        throw new Error(
          `The authoritative reviewer returned an invalid packet group at position ${index + 1}.`,
        );
      }
      const record = rawGroup as Record<string, unknown>;
      const documentIds = normalizeStringArray(record.documentIds);
      if (!documentIds.length) {
        throw new Error(
          `The authoritative reviewer returned an empty packet group at position ${index + 1}.`,
        );
      }
      for (const docId of documentIds) {
        if (!documentsById.has(docId)) {
          throw new Error(
            `The authoritative reviewer grouped an unknown document: ${docId}.`,
          );
        }
        if (assignedDocumentIds.has(docId)) {
          throw new Error(
            `The authoritative reviewer assigned ${docId} to more than one packet group.`,
          );
        }
        assignedDocumentIds.add(docId);
      }

      const relationship = String(record.relationship ?? "standard").trim();
      if (!(relationship === "standard" || relationship === "seller_chain")) {
        throw new Error(
          `The authoritative reviewer returned an invalid packet relationship at position ${index + 1}.`,
        );
      }
      const rationale = compactPromptText(
        String(record.rationale ?? record.reason ?? "").trim(),
        700,
      );
      if (!rationale) {
        throw new Error(
          `The authoritative reviewer did not explain packet group ${index + 1}.`,
        );
      }

      let roleSelection: VerificationGroup["roleSelection"];
      if (relationship === "seller_chain") {
        const primaryDocumentIds = normalizeStringArray(
          record.primaryDocumentIds,
        );
        const contextDocumentIds = normalizeStringArray(
          record.contextDocumentIds,
        );
        const memberIds = new Set(documentIds);
        const rolesAreValid =
          primaryDocumentIds.length > 0 &&
          contextDocumentIds.length > 0 &&
          [...primaryDocumentIds, ...contextDocumentIds].every((id) =>
            memberIds.has(id),
          ) &&
          primaryDocumentIds.every((id) => !contextDocumentIds.includes(id));
        if (!rolesAreValid) {
          throw new Error(
            `The authoritative reviewer returned invalid seller-chain roles for packet group ${index + 1}.`,
          );
        }
        roleSelection = {
          strategy: "seller_chain",
          primaryDocumentIds,
          contextDocumentIds,
          note: rationale,
        };
      }

      const summaryRecord =
        record.caseSummary &&
        typeof record.caseSummary === "object" &&
        !Array.isArray(record.caseSummary)
          ? (record.caseSummary as Record<string, unknown>)
          : null;
      if (!summaryRecord) {
        throw new Error(
          `The authoritative reviewer did not provide caseSummary for packet group ${index + 1}.`,
        );
      }
      const packetCategory = compactPromptText(
        String(summaryRecord.packetCategory ?? "").trim(),
        120,
      );
      if (!packetCategory) {
        throw new Error(
          `The authoritative reviewer did not provide packetCategory for packet group ${index + 1}.`,
        );
      }
      const caseSummary: AuthoritativeCaseSummary = {
        counterpartyName: compactPromptText(
          String(summaryRecord.counterpartyName ?? "").trim(),
          180,
        ),
        poNumber: compactPromptText(
          String(summaryRecord.poNumber ?? "").trim(),
          120,
        ),
        invoiceNumber: compactPromptText(
          String(summaryRecord.invoiceNumber ?? "").trim(),
          120,
        ),
        primaryReference: compactPromptText(
          String(summaryRecord.primaryReference ?? "").trim(),
          120,
        ),
        packetCategory,
        counterpartySource: null,
      };
      const groupDocuments = documentIds.map((id) => documentsById.get(id)!);
      if (sourceNamedSummary) {
        const source = readObjectRecord(summaryRecord.counterpartySource);
        const field = COUNTERPARTY_SOURCE_FIELDS.find(
          (key) => key === source?.field,
        );
        const document = groupDocuments.find((doc) => doc.id === source?.docId);
        // The AI selects the external-party role; the title reads that same
        // verified value, rather than trusting another copied/abbreviated name.
        caseSummary.counterpartyName =
          document && field ? String(document.fields[field] ?? "").trim() : "";
      }
      caseSummary.counterpartySource = assertCounterpartySource({
        source: summaryRecord.counterpartySource,
        counterpartyName: caseSummary.counterpartyName,
        documents: groupDocuments,
        primaryDocumentIds: roleSelection?.primaryDocumentIds,
        contextDocumentIds: roleSelection?.contextDocumentIds,
      });
      const primaryDocuments = groupDocuments.filter(
        (doc) => !roleSelection?.contextDocumentIds.includes(doc.id),
      );
      for (const [summaryField, sourceFields] of [
        ["poNumber", ["poNumber", "referencePoNumber"]],
        ["invoiceNumber", ["invoiceNumber", "referenceInvoiceNumber"]],
      ] as const) {
        const reference = caseSummary[summaryField];
        if (
          reference &&
          !primaryDocuments.some((doc) =>
            sourceFields.some(
              (field) => String(doc.fields[field] ?? "").trim() === reference,
            ),
          )
        ) {
          throw new Error(
            `The case ${summaryField} is not bound to a reviewed reference in its primary documents.`,
          );
        }
      }
      if (
        caseSummary.primaryReference &&
        ![caseSummary.invoiceNumber, caseSummary.poNumber].includes(
          caseSummary.primaryReference,
        )
      ) {
        throw new Error(
          "The case primaryReference is not its reviewed invoice or purchase-order reference.",
        );
      }
      const label = compactPromptText(String(record.label ?? "").trim(), 160);
      if (!label) {
        throw new Error(
          `The authoritative reviewer did not provide a final case label for packet group ${index + 1}.`,
        );
      }
      return {
        groupId: `authoritative-packet-group-${index + 1}`,
        label,
        reason:
          documentIds.length === 1 ? "single_document" : "shared_reference",
        documentIds,
        sourceFileNames: [
          ...new Set(
            groupDocuments
              .map((doc) => doc.sourceFileName)
              .filter((name): name is string => Boolean(name)),
          ),
        ],
        referenceKeys: [],
        ...(roleSelection ? { roleSelection } : {}),
        caseSummary,
      };
    },
  );

  const missingDocumentIds = documents
    .map((doc) => doc.id)
    .filter((id) => !assignedDocumentIds.has(id));
  if (missingDocumentIds.length) {
    throw new Error(
      `The authoritative reviewer left documents out of packet grouping: ${missingDocumentIds.join(", ")}.`,
    );
  }

  return groups;
}

function parseAuthoritativeDocumentAudits(
  value: unknown,
  documents: CaseDoc[],
  rawCorrections: unknown,
  sourcePages: ReviewSourcePage[],
) {
  if (!Array.isArray(value)) {
    throw new Error(
      "The authoritative reviewer response is missing documentAudits.",
    );
  }

  const documentsById = new Map(
    documents.map((document) => [document.id, document]),
  );
  const corrections = Array.isArray(rawCorrections) ? rawCorrections : [];
  const changedDocumentIds = new Set(
    buildCorrectionMutationCandidates({ corrections }, documents).map(
      (change) => change.docId,
    ),
  );
  const correctionsByDocId = new Map<string, Record<string, unknown>>();
  for (const rawCorrection of corrections) {
    if (
      !rawCorrection ||
      typeof rawCorrection !== "object" ||
      Array.isArray(rawCorrection)
    ) {
      continue;
    }
    const correction = rawCorrection as Record<string, unknown>;
    const docId = String(correction.docId ?? "").trim();
    if (docId) correctionsByDocId.set(docId, correction);
  }

  const auditedIds = new Set<string>();
  const parsedAudits: AuthoritativeDocumentAudit[] = [];
  for (const [index, rawAudit] of value.entries()) {
    if (!rawAudit || typeof rawAudit !== "object" || Array.isArray(rawAudit)) {
      throw new Error(
        `The authoritative reviewer returned an invalid document audit at position ${index + 1}.`,
      );
    }
    const audit = rawAudit as Record<string, unknown>;
    const docId = String(audit.docId ?? "").trim();
    const sourceVerdict = audit.sourceVerdict;
    if (
      sourceVerdict !== undefined &&
      sourceVerdict !== "verified" &&
      sourceVerdict !== "needs_review"
    )
      throw new Error(`Invalid sourceVerdict on ${docId}.`);
    const status =
      sourceVerdict === undefined
        ? String(audit.status ?? "").trim()
        : sourceVerdict === "needs_review"
          ? "needs_review"
          : changedDocumentIds.has(docId)
            ? "corrected"
            : "verified";
    const reason = compactPromptText(String(audit.reason ?? "").trim(), 500);
    const document = documentsById.get(docId);
    if (
      !document ||
      auditedIds.has(docId) ||
      !(
        status === "verified" ||
        status === "corrected" ||
        status === "needs_review"
      ) ||
      !reason
    ) {
      throw new Error(
        `The authoritative reviewer returned an incomplete document audit for ${docId || index + 1}.`,
      );
    }
    auditedIds.add(docId);

    for (const [mapKey, supportedKey, unsupportedKey] of [
      ["fieldSupport", "supportedFields", "unsupportedFields"],
      [
        "lineItemPropertySupport",
        "supportedLineItemProperties",
        "unsupportedLineItemProperties",
      ],
    ]) {
      if (audit[mapKey] === undefined) continue;
      const support = readObjectRecord(audit[mapKey]);
      if (
        !support ||
        Object.values(support).some(
          (verdict) => verdict !== "supported" && verdict !== "unsupported",
        )
      ) {
        throw new Error(`Invalid ${mapKey} verdicts on ${docId}.`);
      }
      audit[supportedKey] = Object.keys(support).filter(
        (key) => support[key] === "supported",
      );
      audit[unsupportedKey] = Object.keys(support).filter(
        (key) => support[key] === "unsupported",
      );
    }
    const supportedFields = normalizeReviewFieldList(audit.supportedFields);
    const unsupportedFields = normalizeReviewFieldList(audit.unsupportedFields);
    const visibleOmittedFields = Array.isArray(audit.visibleOmittedFields)
      ? audit.visibleOmittedFields.map((rawOmission) => {
          const omission = readObjectRecord(rawOmission);
          const field = omission?.field;
          const value =
            typeof omission?.value === "string" ? omission.value.trim() : "";
          const evidence = readObjectRecord(omission?.evidence);
          const pageNumber = evidence?.pageNumber;
          const sourceFileName = evidence?.sourceFileName;
          const quote =
            typeof evidence?.quote === "string" ? evidence.quote : "";
          if (
            !isKnownFieldKey(field) ||
            !value ||
            sourceFileName !== document.sourceFileName ||
            typeof pageNumber !== "number" ||
            !Number.isInteger(pageNumber) ||
            pageNumber < 1 ||
            !quote.includes(value) ||
            (document.sourcePageNumbers &&
              !document.sourcePageNumbers.includes(pageNumber)) ||
            (sourcePages.length > 0 &&
              !sourcePages.some(
                (page) =>
                  page.sourceFileName === sourceFileName &&
                  page.pageNumber === pageNumber,
              ))
          ) {
            throw new Error(
              `A visible omission must supply an actual printed value and its own-page evidence on ${docId}; blank, absent and unreadable fields are not printed omissions.`,
            );
          }
          return { field, value };
        })
      : [];
    if (
      new Set(visibleOmittedFields.map((item) => item.field)).size !==
      visibleOmittedFields.length
    ) {
      throw new Error(`Duplicate visible field omissions on ${docId}.`);
    }
    if (
      !Array.isArray(audit.supportedFields) ||
      supportedFields.length !== audit.supportedFields.length ||
      !Array.isArray(audit.unsupportedFields) ||
      unsupportedFields.length !== audit.unsupportedFields.length ||
      !Array.isArray(audit.visibleOmittedFields) ||
      visibleOmittedFields.length !== audit.visibleOmittedFields.length
    ) {
      throw new Error(
        `The authoritative reviewer returned invalid field findings for ${docId}.`,
      );
    }
    const supportedLineItemProperties = Array.isArray(
      audit.supportedLineItemProperties,
    )
      ? [
          ...new Set(
            audit.supportedLineItemProperties.map((property) =>
              String(property ?? "").trim(),
            ),
          ),
        ]
      : [];
    const unsupportedLineItemProperties = Array.isArray(
      audit.unsupportedLineItemProperties,
    )
      ? [
          ...new Set(
            audit.unsupportedLineItemProperties.map((property) =>
              String(property ?? "").trim(),
            ),
          ),
        ]
      : [];
    if (
      !Array.isArray(audit.supportedLineItemProperties) ||
      supportedLineItemProperties.length !==
        audit.supportedLineItemProperties.length ||
      supportedLineItemProperties.some(
        (property) => !REVIEW_LINE_ITEM_PROPERTY_KEY_SET.has(property),
      ) ||
      !Array.isArray(audit.unsupportedLineItemProperties) ||
      unsupportedLineItemProperties.length !==
        audit.unsupportedLineItemProperties.length ||
      unsupportedLineItemProperties.some(
        (property) => !REVIEW_LINE_ITEM_PROPERTY_KEY_SET.has(property),
      )
    ) {
      throw new Error(
        `The authoritative reviewer returned invalid line-item findings for ${docId}.`,
      );
    }

    const populatedFields = Object.entries(document.fields)
      .filter(([, fieldValue]) => String(fieldValue ?? "").trim())
      .map(([field]) => field)
      .filter(isKnownFieldKey);
    const reviewedFields = new Set([...supportedFields, ...unsupportedFields]);
    const duplicateFieldDecisions = supportedFields.filter((field) =>
      unsupportedFields.includes(field),
    );
    if (
      duplicateFieldDecisions.length ||
      reviewedFields.size !== populatedFields.length ||
      populatedFields.some((field) => !reviewedFields.has(field))
    ) {
      throw new Error(
        `The authoritative reviewer did not decide the source support for every populated field on ${docId}. Missing: ${populatedFields.filter((field) => !reviewedFields.has(field)).join(", ") || "none"}. Unexpected: ${[...reviewedFields].filter((field) => !populatedFields.includes(field)).join(", ") || "none"}. Conflicting: ${duplicateFieldDecisions.join(", ") || "none"}. Audit the ORIGINAL populated fields, not the corrected field set.`,
      );
    }

    const populatedLineItemProperties = [
      ...new Set(
        (document.lineItems ?? []).flatMap((item) =>
          Object.entries(item)
            .filter(
              ([property, propertyValue]) =>
                REVIEW_LINE_ITEM_PROPERTY_KEY_SET.has(property) &&
                String(propertyValue ?? "").trim(),
            )
            .map(([property]) => property),
        ),
      ),
    ];
    const reviewedLineItemProperties = new Set([
      ...supportedLineItemProperties,
      ...unsupportedLineItemProperties,
    ]);
    const duplicateLineItemDecisions = supportedLineItemProperties.filter(
      (property) => unsupportedLineItemProperties.includes(property),
    );
    if (
      duplicateLineItemDecisions.length ||
      reviewedLineItemProperties.size !== populatedLineItemProperties.length ||
      populatedLineItemProperties.some(
        (property) => !reviewedLineItemProperties.has(property),
      )
    ) {
      throw new Error(
        `The authoritative reviewer did not decide the source support for every populated line-item property on ${docId}.`,
      );
    }

    const correction = correctionsByDocId.get(docId);
    const hasFindings = Boolean(
      unsupportedFields.length ||
      visibleOmittedFields.length ||
      unsupportedLineItemProperties.length,
    );
    // A repeated document type or null for an already absent field is not a
    // mutation. Do not replay an expensive source review for a no-op record.
    // Actual conflicting mutations and incomplete source audits still fail.
    if (
      status === "verified" &&
      (hasFindings || changedDocumentIds.has(docId))
    ) {
      throw new Error(
        `The authoritative reviewer marked ${docId} verified while also returning changes.`,
      );
    }
    if (status === "corrected" && !correction) {
      throw new Error(
        `The authoritative reviewer marked ${docId} corrected without a correction.`,
      );
    }
    if (hasFindings && !correction) {
      throw new Error(
        `The authoritative reviewer found unsupported or missing values on ${docId} without correcting them.`,
      );
    }
    const parsedAudit: AuthoritativeDocumentAudit = {
      docId,
      status: status as AuthoritativeDocumentAudit["status"],
      supportedFields,
      unsupportedFields,
      visibleOmittedFields,
      supportedLineItemProperties:
        supportedLineItemProperties as ReviewLineItemProperty[],
      unsupportedLineItemProperties:
        unsupportedLineItemProperties as ReviewLineItemProperty[],
      reason,
      referenceEvidence: [],
    };
    if (!correction) {
      parsedAudits.push(parsedAudit);
      continue;
    }

    const correctionFields = readCorrectionFields(correction.fields) ?? {};
    const unsetFields = new Set(
      normalizeReviewFieldList(correction.unsetFields),
    );
    const quarantinedFields = new Set(
      normalizeReviewQuarantineFields(correction.quarantineFields).map(
        (entry) => entry.field,
      ),
    );
    for (const field of unsupportedFields) {
      const isRemoved =
        correctionFields[field] === null ||
        unsetFields.has(field) ||
        quarantinedFields.has(field);
      if (!document.fields[field] || !isRemoved) {
        throw new Error(
          `The authoritative reviewer did not remove the unsupported ${field} value from ${docId}.`,
        );
      }
    }
    for (const { field, value } of visibleOmittedFields) {
      const proposed = correctionFields[field];
      if (
        document.fields[field] ||
        proposed === null ||
        String(proposed ?? "").trim() !== value
      ) {
        throw new Error(
          `The authoritative reviewer did not supply the missing ${field} value for ${docId}.`,
        );
      }
    }
    if (unsupportedLineItemProperties.length) {
      if (!Array.isArray(correction.lineItems)) {
        throw new Error(
          `The authoritative reviewer did not return corrected line items for ${docId}.`,
        );
      }
      for (const property of unsupportedLineItemProperties) {
        const existed = (document.lineItems ?? []).some((item) =>
          Boolean(
            String(item[property as ReviewLineItemProperty] ?? "").trim(),
          ),
        );
        const remains = correction.lineItems.some((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item))
            return false;
          return Boolean(
            String((item as Record<string, unknown>)[property] ?? "").trim(),
          );
        });
        if (!existed || remains) {
          throw new Error(
            `The authoritative reviewer did not remove unsupported line-item ${property} values from ${docId}.`,
          );
        }
      }
    }

    parsedAudits.push(parsedAudit);
  }

  if (auditedIds.size !== documents.length) {
    const missing = documents
      .map((document) => document.id)
      .filter((docId) => !auditedIds.has(docId));
    throw new Error(
      `The authoritative reviewer did not audit every document: ${missing.join(", ") || "count mismatch"}.`,
    );
  }

  return parsedAudits;
}

function validateAuthoritativeSourceReview(
  payload: ExtractionReviewPayload,
  documents: CaseDoc[],
  sourcePages: ReviewSourcePage[],
) {
  const corrections = Array.isArray(payload.corrections)
    ? payload.corrections
    : [];
  if (payload.sourceSupport !== undefined) {
    const support = readObjectRecord(payload.sourceSupport);
    if (
      !support ||
      Object.keys(support).length !== documents.length ||
      documents.some((document) => !Object.hasOwn(support, document.id))
    ) {
      throw new Error(
        "The reviewer sourceSupport must cover exactly the supplied documents.",
      );
    }
    for (const rawAudit of Array.isArray(payload.documentAudits)
      ? payload.documentAudits
      : []) {
      const audit = readObjectRecord(rawAudit);
      if (!audit) continue;
      const entry = readObjectRecord(support[String(audit.docId ?? "")]);
      if (
        !entry ||
        !readObjectRecord(entry.fieldSupport) ||
        !readObjectRecord(entry.lineItemPropertySupport) ||
        Object.keys(entry).some(
          (key) => key !== "fieldSupport" && key !== "lineItemPropertySupport",
        )
      ) {
        throw new Error(
          `Incomplete keyed source support for ${String(audit.docId ?? "unknown")}.`,
        );
      }
      Object.assign(audit, entry);
    }
  }
  const documentAudits = parseAuthoritativeDocumentAudits(
    payload.documentAudits,
    documents,
    corrections,
    sourcePages,
  );
  corrections.forEach((rawCorrection, index) => {
    if (
      !rawCorrection ||
      typeof rawCorrection !== "object" ||
      Array.isArray(rawCorrection)
    ) {
      throw new Error(
        `The authoritative reviewer returned an invalid correction at position ${index + 1}.`,
      );
    }
    const correction = rawCorrection as Record<string, unknown>;
    const docId = String(correction.docId ?? "").trim();
    const document = documents.find((entry) => entry.id === docId);
    const evidence =
      correction.evidence &&
      typeof correction.evidence === "object" &&
      !Array.isArray(correction.evidence)
        ? (correction.evidence as Record<string, unknown>)
        : null;
    const pageNumber = Number(evidence?.pageNumber);
    const sourceFileName = String(evidence?.sourceFileName ?? "").trim();
    const quote = String(evidence?.quote ?? "").trim();
    const evidencePageExists = sourcePages.some(
      (page) =>
        page.sourceFileName === sourceFileName &&
        page.pageNumber === pageNumber,
    );
    if (
      !document ||
      !sourceFileName ||
      sourceFileName !== document.sourceFileName ||
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      !quote ||
      (sourcePages.length > 0 && !evidencePageExists)
    ) {
      throw new Error(
        `The authoritative reviewer did not provide valid source-page evidence for correction ${index + 1}.`,
      );
    }
  });

  // Validate grounding against the values that will actually be saved, not
  // just the original extraction or the reviewer's list of supported keys.
  const proposedDocuments = applyExtractionReviewCorrections(
    documents,
    payload,
    {
      authoritative: true,
    },
  ).documents;
  for (const audit of documentAudits) {
    const rawAudit = (payload.documentAudits as Record<string, unknown>[]).find(
      (entry) => entry.docId === audit.docId,
    );
    audit.referenceEvidence = assertReferenceGrounding({
      document: proposedDocuments.find((doc) => doc.id === audit.docId)!,
      evidence: rawAudit?.referenceEvidence,
      sourcePages,
    });
  }
  assertAuthoritativeDocumentAuditApplied(proposedDocuments, documentAudits);
  return { documents: proposedDocuments, documentAudits };
}

function parseAuthoritativeReviewResult(
  payload: ExtractionReviewPayload,
  documents: CaseDoc[],
  candidateMismatches: Mismatch[],
  sourcePages: ReviewSourcePage[],
): AuthoritativeReviewResult & {
  confirmedMismatchCount: number;
  dismissedMismatchCount: number;
} {
  const sourceReview = validateAuthoritativeSourceReview(
    payload,
    documents,
    sourcePages,
  );
  const mismatchReview = parseAuthoritativeMismatchDecisions(
    payload.mismatchDecisions,
    candidateMismatches,
  );
  return {
    mismatches: mismatchReview.mismatches,
    termsChecklist: parseAuthoritativeTermsChecklist(
      payload.termsChecklist,
      documents,
    ),
    verificationGroups: parseAuthoritativePacketGroups(
      payload.packetGroups,
      sourceReview.documents,
      payload.referenceReviews !== undefined,
    ),
    documentAudits: sourceReview.documentAudits,
    confirmedMismatchCount: mismatchReview.confirmedCount,
    dismissedMismatchCount: mismatchReview.dismissedCount,
  };
}

function correctionMutationId(
  correctionIndex: number,
  kind: CorrectionMutationKind,
  field?: string,
) {
  return `correction-${correctionIndex + 1}:${kind}${field ? `:${field}` : ""}`;
}

function readObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readCorrectionFields(value: unknown): Record<string, unknown> | null {
  const legacyRecord = readObjectRecord(value);
  if (legacyRecord) return legacyRecord;
  if (!Array.isArray(value)) return null;

  const fields: Record<string, unknown> = {};
  for (const entry of value) {
    const record = readObjectRecord(entry);
    const field = record?.field;
    if (
      !record ||
      !isKnownFieldKey(field) ||
      !("value" in record) ||
      Object.hasOwn(fields, field)
    ) {
      return null;
    }
    fields[field] = record.value;
  }
  return fields;
}

function buildCorrectionMutationCandidates(
  payload: ExtractionReviewPayload,
  documents: CaseDoc[],
) {
  const documentsById = new Map(
    documents.map((document) => [document.id, document]),
  );
  const corrections = Array.isArray(payload.corrections)
    ? payload.corrections
    : [];
  const candidates: CorrectionMutationCandidate[] = [];

  corrections.forEach((rawCorrection, correctionIndex) => {
    const correction = readObjectRecord(rawCorrection);
    if (!correction) return;
    const docId = String(correction.docId ?? "").trim();
    const document = documentsById.get(docId);
    if (!document) return;
    const reviewerReason = compactPromptText(
      String(correction.reason ?? "").trim(),
      500,
    );
    const common = {
      correctionIndex,
      docId,
      documentTitle: document.title,
      reviewerReason,
      reviewerEvidence: correction.evidence,
    };

    if (
      isKnownDocType(correction.documentType) &&
      correction.documentType !== document.type
    ) {
      candidates.push({
        ...common,
        id: correctionMutationId(correctionIndex, "documentType"),
        kind: "documentType",
        currentValue: document.type,
        proposedValue: correction.documentType,
      });
    }

    const fields = readCorrectionFields(correction.fields);
    if (fields) {
      Object.entries(fields).forEach(([field, proposedValue]) => {
        if (!isKnownFieldKey(field)) return;
        const currentValue = document.fields[field];
        const normalizedProposed =
          proposedValue === null ? null : normalizeFieldValue(proposedValue);
        if (
          (normalizedProposed === null && currentValue === undefined) ||
          normalizedProposed === currentValue
        ) {
          return;
        }
        candidates.push({
          ...common,
          id: correctionMutationId(correctionIndex, "field", field),
          kind: "field",
          field,
          currentValue: currentValue ?? null,
          proposedValue: normalizedProposed,
        });
      });
    }

    normalizeReviewFieldList(correction.unsetFields).forEach((field) => {
      const currentValue = document.fields[field];
      if (currentValue === undefined) return;
      candidates.push({
        ...common,
        id: correctionMutationId(correctionIndex, "unsetField", field),
        kind: "unsetField",
        field,
        currentValue,
        proposedValue: null,
      });
    });

    normalizeReviewQuarantineFields(correction.quarantineFields).forEach(
      ({ field }) => {
        const currentValue = document.fields[field];
        if (currentValue === undefined) return;
        candidates.push({
          ...common,
          id: correctionMutationId(correctionIndex, "quarantineField", field),
          kind: "quarantineField",
          field,
          currentValue,
          proposedValue: null,
        });
      },
    );

    if (
      Array.isArray(correction.lineItems) &&
      JSON.stringify(correction.lineItems) !==
        JSON.stringify(document.lineItems ?? [])
    ) {
      candidates.push({
        ...common,
        id: correctionMutationId(correctionIndex, "lineItems"),
        kind: "lineItems",
        currentValue: document.lineItems ?? [],
        proposedValue: correction.lineItems,
      });
    }
  });

  return candidates;
}

function filterVerifiedCorrections(
  payload: ExtractionReviewPayload,
  decisions: CorrectionMutationDecision[],
) {
  const acceptedById = new Map(
    decisions
      .filter((decision) => decision.verdict === "accept")
      .map((decision) => [decision.mutationId, decision]),
  );
  const corrections = Array.isArray(payload.corrections)
    ? payload.corrections
    : [];

  return corrections.flatMap((rawCorrection, correctionIndex) => {
    const correction = readObjectRecord(rawCorrection);
    if (!correction) return [];
    const verified: Record<string, unknown> = {
      docId: correction.docId,
    };
    const acceptedDecisions: CorrectionMutationDecision[] = [];
    const accept = (kind: CorrectionMutationKind, field?: string) => {
      const decision = acceptedById.get(
        correctionMutationId(correctionIndex, kind, field),
      );
      if (decision) acceptedDecisions.push(decision);
      return Boolean(decision);
    };

    if (accept("documentType")) {
      verified.documentType = correction.documentType;
    }

    const fields = readCorrectionFields(correction.fields);
    if (fields) {
      const acceptedFields = Object.fromEntries(
        Object.entries(fields).filter(([field]) => accept("field", field)),
      );
      if (Object.keys(acceptedFields).length) verified.fields = acceptedFields;
    }

    const unsetFields = normalizeReviewFieldList(correction.unsetFields).filter(
      (field) => accept("unsetField", field),
    );
    if (unsetFields.length) verified.unsetFields = unsetFields;

    const quarantineFields = Array.isArray(correction.quarantineFields)
      ? correction.quarantineFields.filter((entry) => {
          const record = readObjectRecord(entry);
          const field = typeof entry === "string" ? entry : record?.field;
          return typeof field === "string" && accept("quarantineField", field);
        })
      : [];
    if (quarantineFields.length) verified.quarantineFields = quarantineFields;

    if (Array.isArray(correction.lineItems) && accept("lineItems")) {
      verified.lineItems = correction.lineItems;
    }

    if (!acceptedDecisions.length) return [];
    verified.evidence = acceptedDecisions[0].evidence;
    verified.reason = compactPromptText(
      acceptedDecisions.map((decision) => decision.reason).join(" "),
      500,
    );
    return [verified];
  });
}

function summarizeMutationValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "missing";
  if (Array.isArray(value))
    return `${value.length} line item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") {
    return compactPromptText(JSON.stringify(value), 240);
  }
  return compactPromptText(String(value), 240);
}

function buildCorrectionValidationIssues(
  candidates: CorrectionMutationCandidate[],
  decisions: CorrectionMutationDecision[],
): Mismatch[] {
  const candidatesById = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  return decisions.flatMap((decision, index) => {
    if (decision.verdict !== "needs_review") return [];
    const candidate = candidatesById.get(decision.mutationId);
    if (!candidate) return [];
    const field =
      candidate.field && isKnownFieldKey(candidate.field)
        ? candidate.field
        : EXTRACTION_VERIFICATION_FIELD;
    return [
      {
        id: `independent-review-${index + 1}-${candidate.id}`,
        field,
        values: [
          {
            docId: candidate.docId,
            value: `Current: ${summarizeMutationValue(candidate.currentValue)}; proposed: ${summarizeMutationValue(candidate.proposedValue)}`,
          },
        ],
        analysis: `Independent source verification could not safely accept the proposed extraction change. ${decision.reason}`,
        fixPlan:
          "Open the cited source page and verify the printed value. Keep the case in review until the source evidence is decisive.",
      },
    ];
  });
}

function applyIndependentReviewIssueDecisions(
  candidates: Mismatch[],
  decisions: IndependentReviewIssueDecision[],
) {
  const decisionsById = new Map(
    decisions.map((decision) => [decision.reviewIssueId, decision]),
  );
  return candidates.flatMap((candidate) => {
    const decision = decisionsById.get(candidate.id);
    if (!decision || decision.verdict === "dismissed") return [];
    return [
      {
        ...candidate,
        analysis: decision.reason,
      },
    ];
  });
}

function mergePageQualityConsensus(
  primary: DocumentPageQualityAssessment[],
  independent: DocumentPageQualityAssessment[],
) {
  const independentByPage = new Map(
    independent.map((assessment) => [
      `${assessment.sourceFileName}\u0000${assessment.pageNumber}`,
      assessment,
    ]),
  );
  return primary.map((assessment) => {
    const key = `${assessment.sourceFileName}\u0000${assessment.pageNumber}`;
    const audit = independentByPage.get(key);
    if (!audit || audit.documentId !== assessment.documentId) {
      throw new Error(
        `Independent review returned inconsistent page identity for ${assessment.sourceFileName}, page ${assessment.pageNumber}.`,
      );
    }
    if (assessment.approvalSafe && audit.approvalSafe) return audit;
    const unsafeAssessments = [assessment, audit].filter(
      (entry) => !entry.approvalSafe,
    );
    return {
      ...assessment,
      issues: Array.from(
        new Set(unsafeAssessments.flatMap((entry) => entry.issues)),
      ),
      approvalSafe: false,
      confidence: unsafeAssessments[0]?.confidence ?? "medium",
      reason: Array.from(
        new Set(unsafeAssessments.map((entry) => entry.reason)),
      ).join(" Independent review: "),
    };
  });
}

function parseIndependentReviewValidation(
  raw: string,
  candidates: CorrectionMutationCandidate[],
  reviewIssueCandidates: Mismatch[],
  documents: CaseDoc[],
  sourcePages: ReviewSourcePage[],
) {
  const payload = safeJsonParse<Record<string, unknown> | null>(raw, null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("The independent reviewer did not return a JSON object.");
  }
  if (!Array.isArray(payload.correctionDecisions)) {
    throw new Error(
      "The independent reviewer did not return correctionDecisions.",
    );
  }
  if (
    reviewIssueCandidates.length > 0 &&
    !Array.isArray(payload.reviewIssueDecisions)
  ) {
    throw new Error(
      "The independent reviewer did not return reviewIssueDecisions.",
    );
  }
  const candidatesById = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  const documentsById = new Map(
    documents.map((document) => [document.id, document]),
  );
  const decisions = new Map<string, CorrectionMutationDecision>();

  payload.correctionDecisions.forEach((rawDecision, index) => {
    const record = readObjectRecord(rawDecision);
    if (!record) {
      throw new Error(
        `The independent reviewer returned an invalid correction decision at position ${index + 1}.`,
      );
    }
    const mutationId = String(record.mutationId ?? "").trim();
    const verdict = String(record.verdict ?? "").trim();
    const reason = compactPromptText(String(record.reason ?? "").trim(), 700);
    const evidence = readObjectRecord(record.evidence);
    const sourceFileName = String(evidence?.sourceFileName ?? "").trim();
    const pageNumber = Number(evidence?.pageNumber);
    const quote = String(evidence?.quote ?? "").trim();
    const candidate = candidatesById.get(mutationId);
    const document = candidate ? documentsById.get(candidate.docId) : null;
    const pageExists = sourcePages.some(
      (page) =>
        page.sourceFileName === sourceFileName &&
        page.pageNumber === pageNumber,
    );
    if (
      !candidate ||
      decisions.has(mutationId) ||
      !(["accept", "keep_original", "needs_review"] as string[]).includes(
        verdict,
      ) ||
      !reason ||
      !document ||
      !sourceFileName ||
      sourceFileName !== document.sourceFileName ||
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      !quote ||
      (sourcePages.length > 0 && !pageExists)
    ) {
      throw new Error(
        `The independent reviewer returned an incomplete or invalid decision for mutation ${mutationId || index + 1}.`,
      );
    }
    decisions.set(mutationId, {
      mutationId,
      verdict: verdict as CorrectionMutationDecision["verdict"],
      reason,
      evidence: { sourceFileName, pageNumber, quote },
    });
  });

  if (decisions.size !== candidates.length) {
    const missing = candidates
      .map((candidate) => candidate.id)
      .filter((id) => !decisions.has(id));
    throw new Error(
      `The independent reviewer did not decide every proposed correction: ${missing.join(", ") || "count mismatch"}.`,
    );
  }

  const reviewIssuesById = new Map(
    reviewIssueCandidates.map((candidate) => [candidate.id, candidate]),
  );
  const reviewIssueDecisions = new Map<
    string,
    IndependentReviewIssueDecision
  >();
  const rawReviewIssueDecisions = Array.isArray(payload.reviewIssueDecisions)
    ? payload.reviewIssueDecisions
    : [];
  rawReviewIssueDecisions.forEach((rawDecision, index) => {
    const record = readObjectRecord(rawDecision);
    const reviewIssueId = String(record?.reviewIssueId ?? "").trim();
    const verdict = String(record?.verdict ?? "").trim();
    const reason = compactPromptText(String(record?.reason ?? "").trim(), 700);
    if (
      !record ||
      !reviewIssuesById.has(reviewIssueId) ||
      reviewIssueDecisions.has(reviewIssueId) ||
      !(["confirmed", "dismissed", "needs_review"] as string[]).includes(
        verdict,
      ) ||
      !reason
    ) {
      throw new Error(
        `The independent reviewer returned an incomplete or invalid review-issue decision at position ${index + 1}.`,
      );
    }
    reviewIssueDecisions.set(reviewIssueId, {
      reviewIssueId,
      verdict: verdict as IndependentReviewIssueDecision["verdict"],
      reason,
    });
  });
  if (reviewIssueDecisions.size !== reviewIssueCandidates.length) {
    const missing = reviewIssueCandidates
      .map((candidate) => candidate.id)
      .filter((id) => !reviewIssueDecisions.has(id));
    throw new Error(
      `The independent reviewer did not decide every proposed review issue: ${missing.join(", ") || "count mismatch"}.`,
    );
  }

  const pageQuality = parseDocumentPageQuality({
    value: payload.pageQuality,
    sourcePages,
    documents,
  });
  return {
    decisions: [...decisions.values()],
    reviewIssueDecisions: [...reviewIssueDecisions.values()],
    pageQuality,
  };
}

async function independentlyValidateAuthoritativeReview(params: {
  payload: ExtractionReviewPayload;
  documents: CaseDoc[];
  sourcePages: ReviewSourcePage[];
  primaryPageQuality: DocumentPageQualityAssessment[];
}): Promise<IndependentReviewValidation> {
  const candidates = buildCorrectionMutationCandidates(
    params.payload,
    params.documents,
  );
  const reviewIssueCandidates = buildEvidenceBackedExtractionReviewIssues(
    params.documents,
    params.payload.reviewIssues,
  );
  if (
    !candidates.length &&
    !reviewIssueCandidates.length &&
    !params.sourcePages.length
  ) {
    return {
      corrections: [],
      pageQuality: params.primaryPageQuality,
      reviewIssues: [],
      proposedCount: 0,
      verifiedCount: 0,
      rejectedCount: 0,
      unresolvedCount: 0,
      proposedReviewIssueCount: 0,
      verifiedReviewIssueCount: 0,
      dismissedReviewIssueCount: 0,
      unresolvedReviewIssueCount: 0,
      warnings: [],
    };
  }

  const validationContext = JSON.stringify({
    proposedMutations: candidates,
    proposedReviewIssues: reviewIssueCandidates,
    firstReviewPageQuality: params.primaryPageQuality,
    documents: buildExtractionReviewPrompt(params.documents).map(
      (document) => ({
        docId: document.docId,
        documentType: document.documentType,
        title: document.title,
        sourceFileName: document.sourceFileName,
        fields: document.fields,
        lineItems: document.lineItems,
        visibleText: document.visibleText,
      }),
    ),
  });
  const requestText =
    "Independently audit these proposed extraction mutations, proposed review issues, and page-quality assessments against the original source pages. " +
    "The first reviewer is untrusted evidence, not authority. Decide every mutation separately. Accept only when the proposed value is explicitly and decisively supported by the cited source page and is more accurate than the current value. Keep the original when it is at least as well supported, including when the proposal drops, inserts, substitutes, or reorders punctuation, separators, digits, letters, spacing, or leading zeroes that are visibly part of an identifier. Use needs_review when neither value can be verified safely. Never accept a change merely because it makes documents agree. Never infer from filenames, arithmetic, or expected formats. " +
    "Do not accept a partially correct or truncated proposed value merely because it improves the current value; every visible identifier, product description, material grade, amount, unit, and table row in the proposed mutation must be complete. " +
    "Decide every proposed review issue independently. Confirm it only when the cited source pages show a genuine unresolved conflict. Dismiss it when the cited values are equal or semantically equivalent, the source does not support the claim, or an accepted correction resolves it. Use needs_review only when the original pages are genuinely insufficient to decide. " +
    "Reassess every source page visually and independently. A page is approval-safe only when it is upright and every critical value is comfortably readable without relying on OCR. " +
    'Return only JSON: {"correctionDecisions":[{"mutationId":"exact proposed mutation id","verdict":"accept|keep_original|needs_review","reason":"concise source-based reason","evidence":{"sourceFileName":"exact source filename","pageNumber":1,"quote":"minimum exact visible words"}}],"reviewIssueDecisions":[{"reviewIssueId":"exact proposed review issue id","verdict":"confirmed|dismissed|needs_review","reason":"concise source-based reason"}],"pageQuality":[{"sourceFileName":"exact source filename","pageNumber":1,"documentId":"exact document id","issues":["faint|rotated|blurred|cropped|unreadable"],"approvalSafe":true,"confidence":"high|medium|low","reason":"short visual assessment"}]}. Include every mutation, every proposed review issue, and every source page exactly once; use empty arrays when a category has no candidates.\n\n' +
    validationContext;
  const userContent = params.sourcePages.length
    ? [
        { type: "text" as const, text: requestText },
        ...params.sourcePages.flatMap((page) => [
          {
            type: "text" as const,
            text: `Original source page: ${page.sourceFileName}, page ${page.pageNumber}`,
          },
          { type: "image_url" as const, image_url: { url: page.image } },
        ]),
      ]
    : requestText;
  const messages = [
    {
      role: "system" as const,
      content:
        "You are an independent procurement evidence verifier. Return only the required JSON. Preserve source truth exactly and fail closed when visual evidence is uncertain.",
    },
    { role: "user" as const, content: userContent },
  ] as Parameters<typeof callExtractionReviewModel>[0];

  let attemptCount = 0;
  let formatError = "";
  let parsed:
    | {
        decisions: CorrectionMutationDecision[];
        reviewIssueDecisions: IndependentReviewIssueDecision[];
        pageQuality: DocumentPageQualityAssessment[];
      }
    | undefined;
  while (attemptCount < 2 && !parsed) {
    attemptCount += 1;
    const attemptMessages =
      attemptCount === 1
        ? messages
        : [
            ...messages,
            {
              role: "user" as const,
              content: `Your previous response failed the validation contract: ${formatError} Return the complete JSON with every mutation, proposed review issue, and source page exactly once.`,
            },
          ];
    const raw = await callExtractionReviewModel(attemptMessages, {
      operation: "extraction-review-validation",
      responseSchema: {
        name: "samrat_independent_review",
        schema: INDEPENDENT_REVIEW_RESPONSE_SCHEMA,
      },
    });
    try {
      parsed = parseIndependentReviewValidation(
        raw,
        candidates,
        reviewIssueCandidates,
        params.documents,
        params.sourcePages,
      );
    } catch (error) {
      formatError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!parsed) {
    throw new Error(
      `Independent extraction validation failed after ${attemptCount} attempts. ${formatError}`,
    );
  }

  const verifiedCorrections = filterVerifiedCorrections(
    params.payload,
    parsed.decisions,
  );
  const reviewIssues = [
    ...applyIndependentReviewIssueDecisions(
      reviewIssueCandidates,
      parsed.reviewIssueDecisions,
    ),
    ...buildCorrectionValidationIssues(candidates, parsed.decisions),
  ];
  const rejected = parsed.decisions.filter(
    (decision) => decision.verdict === "keep_original",
  );
  return {
    corrections: verifiedCorrections,
    pageQuality: mergePageQualityConsensus(
      params.primaryPageQuality,
      parsed.pageQuality,
    ),
    reviewIssues,
    proposedCount: candidates.length,
    verifiedCount: parsed.decisions.filter(
      (decision) => decision.verdict === "accept",
    ).length,
    rejectedCount: rejected.length,
    unresolvedCount: parsed.decisions.filter(
      (decision) => decision.verdict === "needs_review",
    ).length,
    proposedReviewIssueCount: reviewIssueCandidates.length,
    verifiedReviewIssueCount: parsed.reviewIssueDecisions.filter(
      (decision) => decision.verdict === "confirmed",
    ).length,
    dismissedReviewIssueCount: parsed.reviewIssueDecisions.filter(
      (decision) => decision.verdict === "dismissed",
    ).length,
    unresolvedReviewIssueCount: parsed.reviewIssueDecisions.filter(
      (decision) => decision.verdict === "needs_review",
    ).length,
    warnings: [
      ...rejected.map(
        (decision) =>
          `Independent source review kept the original value for ${decision.mutationId}: ${decision.reason}`,
      ),
      ...parsed.reviewIssueDecisions
        .filter((decision) => decision.verdict === "dismissed")
        .map(
          (decision) =>
            `Independent source review dismissed ${decision.reviewIssueId}: ${decision.reason}`,
        ),
    ],
  };
}

function isKnownDocType(value: unknown): value is DocType {
  return (
    typeof value === "string" && SUPPORTED_DOC_TYPES.includes(value as DocType)
  );
}

function isKnownFieldKey(value: unknown): value is FieldKey {
  return (
    typeof value === "string" &&
    ALL_ALLOWED_FIELD_KEYS.includes(value as FieldKey)
  );
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function normalizeReviewFieldList(value: unknown) {
  return normalizeStringArray(value).filter(isKnownFieldKey);
}

function normalizeReviewQuarantineFields(
  value: unknown,
): Array<{ field: FieldKey; reason?: string }> {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (isKnownFieldKey(entry)) return [{ field: entry }];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const field = record.field;
    if (!isKnownFieldKey(field)) return [];
    const reason = String(record.reason ?? "").trim();
    return [{ field, ...(reason ? { reason } : {}) }];
  });
}

function getVisibleTextFromMarkdown(markdown: string | undefined) {
  const raw = String(markdown ?? "");
  const marker = "## Visible Text";
  const markerIndex = raw.indexOf(marker);
  if (markerIndex >= 0) {
    return raw
      .slice(markerIndex + marker.length)
      .replace(/^#+\s+Page\s+\d+\s*$/gim, "")
      .trim();
  }
  return raw.trim();
}

function buildExtractionReviewPrompt(documents: CaseDoc[]) {
  return documents.map((doc, index) => ({
    index: index + 1,
    docId: doc.id,
    documentType: doc.type,
    title: doc.title,
    sourceFileName: doc.sourceFileName,
    sourceHint: doc.sourceHint,
    sourcePageNumbers: doc.sourcePageNumbers,
    fields: doc.fields,
    lineItems: (doc.lineItems ?? []).slice(0, 40),
    allowedFieldKeys: getAllowedFieldKeysForDocType(doc.type),
    populatedFieldKeys: Object.entries(doc.fields)
      .filter(([, value]) => String(value ?? "").trim())
      .map(([key]) => key),
    populatedLineItemProperties: [
      ...new Set(
        (doc.lineItems ?? []).flatMap((item) =>
          Object.entries(item)
            .filter(
              ([property, value]) =>
                REVIEW_LINE_ITEM_PROPERTY_KEY_SET.has(property) &&
                String(value ?? "").trim(),
            )
            .map(([property]) => property),
        ),
      ),
    ],
    qualityIssues: doc.qualityIssues ?? [],
    reviewFlags: {
      lineItemArithmeticConflict: hasLineItemArithmeticConflict(doc),
    },
    visibleText: compactPromptText(getVisibleTextFromMarkdown(doc.md), 4500),
  }));
}

function rebuildReviewedMarkdown(
  doc: CaseDoc,
  originalMarkdown: string | undefined,
) {
  const visibleText = getVisibleTextFromMarkdown(originalMarkdown);
  return buildMarkdown(doc, visibleText ? [visibleText] : []);
}

function appendReviewQualityIssue(
  issues: ExtractionQualityIssue[],
  field: FieldKey,
  originalValue: string,
  action: ExtractionQualityIssue["action"],
  reason: string,
) {
  const alreadyPresent = issues.some(
    (issue) =>
      issue.field === field &&
      issue.originalValue === originalValue &&
      issue.action === action &&
      issue.reason === reason,
  );
  if (!alreadyPresent) {
    issues.push({ field, originalValue, action, reason });
  }
}

function preserveSourceSupportedWeighmentTriple(
  originalDoc: CaseDoc,
  reviewedDoc: CaseDoc,
  originalQualityIssueCount: number,
) {
  if (originalDoc.type !== "Weighment Slip") {
    return { document: reviewedDoc, restoredFields: [] as FieldKey[] };
  }

  const originalGross = normalizeWeightForDisplay(
    originalDoc.fields.grossWeight,
  )?.kg;
  const originalTare = normalizeWeightForDisplay(
    originalDoc.fields.tareWeight,
  )?.kg;
  const originalNet = normalizeWeightForDisplay(
    originalDoc.fields.netWeight,
  )?.kg;
  if (
    originalGross === undefined ||
    originalTare === undefined ||
    originalNet === undefined ||
    !numbersClose(originalGross - originalTare, originalNet, 5)
  ) {
    return { document: reviewedDoc, restoredFields: [] as FieldKey[] };
  }

  const spelledNet = findSpelledNetWeightKg(
    originalDoc.md ?? "",
    originalDoc.fields.netWeight,
  );
  if (spelledNet === null || !numbersClose(originalNet, spelledNet, 5)) {
    return { document: reviewedDoc, restoredFields: [] as FieldKey[] };
  }

  const reviewedNet = normalizeWeightForDisplay(
    reviewedDoc.fields.netWeight,
  )?.kg;
  if (reviewedNet !== undefined && numbersClose(reviewedNet, spelledNet, 5)) {
    return { document: reviewedDoc, restoredFields: [] as FieldKey[] };
  }

  const restoredFields = EVIDENCE_WEIGHT_FIELDS.filter(
    (field) => originalDoc.fields[field] !== reviewedDoc.fields[field],
  );
  if (!restoredFields.length) {
    return { document: reviewedDoc, restoredFields: [] as FieldKey[] };
  }

  const restoredFieldSet = new Set<FieldKey>(restoredFields);
  const fields = { ...reviewedDoc.fields };
  for (const field of restoredFields) {
    const originalValue = originalDoc.fields[field];
    if (originalValue) fields[field] = originalValue;
    else delete fields[field];
  }

  return {
    document: {
      ...reviewedDoc,
      fields,
      qualityIssues: [
        ...(reviewedDoc.qualityIssues ?? []).slice(
          0,
          originalQualityIssueCount,
        ),
        ...(reviewedDoc.qualityIssues ?? [])
          .slice(originalQualityIssueCount)
          .filter((issue) => !restoredFieldSet.has(issue.field)),
      ],
    },
    restoredFields,
  };
}

type ExtractionReviewIssueInput = {
  field?: unknown;
  evidence?: unknown;
  reason?: unknown;
};

const REVIEW_DATE_FIELDS = new Set<FieldKey>([
  "certificateDate",
  "documentDate",
  "ackDate",
  "transactionDate",
  "validityDate",
  "dateOfBirth",
  "statementDate",
  "photoTimestamp",
]);

const REVIEW_TAX_RATE_FIELDS = new Set<FieldKey>([
  "taxRate",
  "cgstRate",
  "sgstRate",
  "igstRate",
]);

function visibleTextSupportsTaxRate(
  doc: CaseDoc,
  field: FieldKey,
  proposedValue: string,
) {
  if (!REVIEW_TAX_RATE_FIELDS.has(field)) return false;
  const proposedRate = parseTaxRateField(proposedValue);
  if (proposedRate === null) return false;

  const label =
    field === "taxRate"
      ? "(?:GST|TAX)"
      : field.replace(/Rate$/, "").toUpperCase();
  const pattern = new RegExp(
    "\\b" +
      label +
      "\\b(?:\\s*(?:RATE|AT|@))?\\s*[:#|.=-]*\\s*(\\d{1,2}(?:\\.\\d+)?)\\s*%",
    "gi",
  );
  return [...getVisibleTextFromMarkdown(doc.md).matchAll(pattern)].some(
    (match) => {
      const visibleRate = parseTaxRateField(match[1]);
      return (
        visibleRate !== null && Math.abs(visibleRate - proposedRate) <= 0.01
      );
    },
  );
}

function normalizeEvidenceDate(value: unknown) {
  const text = String(value ?? "").trim();
  const yearFirst = text.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  const dayFirst = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  const match = yearFirst ?? dayFirst;
  if (!match) return null;
  const [year, month, day] = yearFirst
    ? [match[1], match[2], match[3]]
    : [match[3], match[2], match[1]];
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) {
    return null;
  }
  return `${year}-${String(monthNumber).padStart(2, "0")}-${String(
    dayNumber,
  ).padStart(2, "0")}`;
}

function visibleTextContainsEvidenceDate(doc: CaseDoc, normalizedDate: string) {
  const visibleText = getVisibleTextFromMarkdown(doc.md);
  const candidates = visibleText.match(
    /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})\b/g,
  );
  return (candidates ?? []).some(
    (candidate) => normalizeEvidenceDate(candidate) === normalizedDate,
  );
}

function compactEvidenceValue(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-IN")
    .replace(/[^a-z0-9]/g, "");
}

function exactReviewEvidenceValue(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-IN");
}

function hasLogicallyDistinctReviewEvidence(
  values: Array<{ docId: string; value: string }>,
  field: FieldKey,
) {
  const documentIds = new Set(values.map((entry) => entry.docId));
  if (documentIds.size < 2) return true;
  const first = values[0]?.value;
  if (!first) return false;
  return values
    .slice(1)
    .some(
      (entry) =>
        exactReviewEvidenceValue(entry.value) !==
          exactReviewEvidenceValue(first) &&
        !areComparableValuesEqual(
          first,
          entry.value,
          DEFAULT_COMPARISON_OPTIONS,
          field,
        ),
    );
}

function sourceSupportsReviewEvidence(
  doc: CaseDoc,
  field: FieldKey,
  value: string,
) {
  const compactValue = compactEvidenceValue(value);
  if (!compactValue) return false;

  const structuredCandidates = [
    doc.fields[field],
    ...((doc.qualityIssues ?? [])
      .filter((issue) => issue.field === field)
      .map((issue) => issue.originalValue) ?? []),
  ];
  if (REVIEW_DATE_FIELDS.has(field)) {
    const normalizedDate = normalizeEvidenceDate(value);
    if (
      normalizedDate &&
      (structuredCandidates.some(
        (candidate) => normalizeEvidenceDate(candidate) === normalizedDate,
      ) ||
        visibleTextContainsEvidenceDate(doc, normalizedDate))
    ) {
      return true;
    }
  }
  if (
    structuredCandidates.some(
      (candidate) => compactEvidenceValue(candidate) === compactValue,
    )
  ) {
    return true;
  }
  if (visibleTextSupportsTaxRate(doc, field, value)) return true;

  // Require enough characters for a useful source-text check. Short values
  // such as "No" or "1" are too common to establish field-level evidence.
  return (
    compactValue.length >= 4 &&
    compactEvidenceValue(getVisibleTextFromMarkdown(doc.md)).includes(
      compactValue,
    )
  );
}

function buildEvidenceBackedExtractionReviewIssues(
  documents: CaseDoc[],
  rawIssues: unknown,
): Mismatch[] {
  if (!Array.isArray(rawIssues)) return [];

  const documentsById = new Map(documents.map((doc) => [doc.id, doc]));
  const seen = new Set<string>();

  return rawIssues.flatMap((rawIssue, issueIndex) => {
    if (!rawIssue || typeof rawIssue !== "object" || Array.isArray(rawIssue)) {
      return [];
    }
    const issue = rawIssue as ExtractionReviewIssueInput;
    if (!isKnownFieldKey(issue.field) || !Array.isArray(issue.evidence)) {
      return [];
    }

    const values = issue.evidence.flatMap((rawEvidence) => {
      if (
        !rawEvidence ||
        typeof rawEvidence !== "object" ||
        Array.isArray(rawEvidence)
      ) {
        return [];
      }
      const evidence = rawEvidence as Record<string, unknown>;
      const docId = String(evidence.docId ?? "").trim();
      const value = normalizeFieldValue(evidence.value);
      const doc = documentsById.get(docId);
      if (!docId || !value || !doc) return [];
      if (!sourceSupportsReviewEvidence(doc, issue.field as FieldKey, value)) {
        return [];
      }
      return [{ docId, value }];
    });
    if (!values.length) return [];

    const dedupedValues = values.filter(
      (entry, index) =>
        values.findIndex(
          (candidate) =>
            candidate.docId === entry.docId &&
            compactEvidenceValue(candidate.value) ===
              compactEvidenceValue(entry.value),
        ) === index,
    );
    // A cross-document mismatch whose cited values are literally identical is
    // logically impossible. This is a field-agnostic integrity invariant, not
    // document-specific parsing: AI review may still adjudicate formatting or
    // semantic equivalence, but an internally contradictory issue must never
    // reach the customer-facing mismatch list.
    if (
      !hasLogicallyDistinctReviewEvidence(
        dedupedValues,
        issue.field as FieldKey,
      )
    )
      return [];
    const signature = `${issue.field}:${dedupedValues
      .map((entry) => `${entry.docId}:${compactEvidenceValue(entry.value)}`)
      .sort()
      .join("|")}`;
    if (seen.has(signature)) return [];
    seen.add(signature);

    const label = FIELD_LABELS[issue.field as FieldKey] ?? String(issue.field);
    const reason = compactPromptText(String(issue.reason ?? "").trim(), 600);
    return [
      {
        id: `evidence-review-${issueIndex + 1}-${String(issue.field)}`,
        field: String(issue.field),
        values: dedupedValues,
        analysis:
          reason ||
          `${label} has unresolved, source-supported evidence that requires review.`,
        fixPlan:
          `1. Open the cited source page and verify the ${label.toLowerCase()}.\n` +
          "2. Confirm whether the visible value is correct, incomplete, or an OCR error.\n" +
          "3. Accept this review item only after the packet evidence is reconciled.",
      },
    ];
  });
}

function applyExtractionReviewCorrections(
  documents: CaseDoc[],
  payload: ExtractionReviewPayload,
  options: { authoritative?: boolean } = {},
): { documents: CaseDoc[]; summary: ExtractionReviewSummary } {
  const warnings: string[] = [];
  const rawCorrections = Array.isArray(payload.corrections)
    ? payload.corrections
    : [];
  const documentsById = new Map(documents.map((doc) => [doc.id, doc]));
  const correctedById = new Map<string, CaseDoc>();
  const applied: ExtractionReviewSummary["corrections"] = [];

  for (const rawCorrection of rawCorrections.slice(0, 80)) {
    if (
      !rawCorrection ||
      typeof rawCorrection !== "object" ||
      Array.isArray(rawCorrection)
    ) {
      warnings.push("Ignored malformed extraction review correction.");
      continue;
    }

    const correction = rawCorrection as ExtractionReviewCorrection;
    const docId = String(correction.docId ?? "").trim();
    const originalDoc = correctedById.get(docId) ?? documentsById.get(docId);
    if (!docId || !originalDoc) {
      warnings.push(
        `Ignored extraction review correction for unknown document id: ${docId || "<missing>"}.`,
      );
      continue;
    }

    let nextDoc: CaseDoc = {
      ...originalDoc,
      fields: { ...originalDoc.fields },
      qualityIssues: [...(originalDoc.qualityIssues ?? [])],
    };
    const originalQualityIssueCount = nextDoc.qualityIssues?.length ?? 0;
    const changedFields: string[] = [];
    const unsetFields: string[] = [];
    const quarantinedFields: string[] = [];
    let documentType: string | undefined;
    let lineItemsReplaced = false;
    const reason = compactPromptText(
      String(correction.reason ?? "").trim(),
      500,
    );

    if (correction.documentType !== undefined) {
      if (
        isKnownDocType(correction.documentType) &&
        correction.documentType !== nextDoc.type
      ) {
        nextDoc = {
          ...nextDoc,
          type: correction.documentType,
          title: `${formatDocType(correction.documentType)} — ${nextDoc.sourceHint ?? nextDoc.sourceFileName ?? nextDoc.title}`,
        };
        documentType = correction.documentType;
      } else if (
        correction.documentType &&
        !isKnownDocType(correction.documentType)
      ) {
        warnings.push(
          `Ignored invalid documentType from extraction review for ${docId}: ${String(correction.documentType)}.`,
        );
      }
    }

    // Authoritative source review decides whether a known field belongs on the
    // original page. A template-specific field whitelist must not discard a
    // value the reviewer has just proved (e.g. a consignee on a weight slip).
    const allowedFields = new Set(
      options.authoritative
        ? ALL_ALLOWED_FIELD_KEYS
        : getAllowedFieldKeysForDocType(nextDoc.type),
    );
    const correctionFields = readCorrectionFields(correction.fields);
    if (correctionFields) {
      for (const [rawKey, rawValue] of Object.entries(correctionFields)) {
        if (!isKnownFieldKey(rawKey)) {
          warnings.push(
            `Ignored invalid field key from extraction review for ${docId}: ${rawKey}.`,
          );
          continue;
        }
        if (!allowedFields.has(rawKey)) {
          warnings.push(
            `Ignored field ${rawKey} for ${docId} because it is not allowed on ${nextDoc.type}.`,
          );
          continue;
        }

        if (rawValue === null) {
          const originalValue = nextDoc.fields[rawKey];
          if (originalValue) {
            delete nextDoc.fields[rawKey];
            unsetFields.push(rawKey);
            appendReviewQualityIssue(
              nextDoc.qualityIssues ?? [],
              rawKey,
              originalValue,
              "quarantined",
              reason ||
                "Second-pass extraction review removed this unsupported value.",
            );
          }
          continue;
        }

        const value = normalizeFieldValue(rawValue);
        if (!value) continue;
        if (
          !options.authoritative &&
          !sourceSupportsReviewEvidence(originalDoc, rawKey, value)
        ) {
          warnings.push(
            `Ignored unsupported field correction for ${docId}.${rawKey}: the proposed value was not found in that document's evidence.`,
          );
          continue;
        }
        const oldValue = nextDoc.fields[rawKey];
        if (oldValue !== value) {
          nextDoc.fields[rawKey] = value;
          changedFields.push(rawKey);
          appendReviewQualityIssue(
            nextDoc.qualityIssues ?? [],
            rawKey,
            oldValue ?? "<missing>",
            "corrected",
            reason ||
              "Second-pass extraction review corrected this value from packet evidence.",
          );
        }
      }
    }

    for (const field of normalizeReviewFieldList(correction.unsetFields)) {
      if (!allowedFields.has(field)) continue;
      const originalValue = nextDoc.fields[field];
      if (!originalValue) continue;
      delete nextDoc.fields[field];
      unsetFields.push(field);
      appendReviewQualityIssue(
        nextDoc.qualityIssues ?? [],
        field,
        originalValue,
        "quarantined",
        reason ||
          "Second-pass extraction review removed this value as unsupported by packet evidence.",
      );
    }

    for (const entry of normalizeReviewQuarantineFields(
      correction.quarantineFields,
    )) {
      if (!allowedFields.has(entry.field)) continue;
      const originalValue = nextDoc.fields[entry.field];
      if (!originalValue) continue;
      delete nextDoc.fields[entry.field];
      quarantinedFields.push(entry.field);
      appendReviewQualityIssue(
        nextDoc.qualityIssues ?? [],
        entry.field,
        originalValue,
        "quarantined",
        entry.reason ||
          reason ||
          "Second-pass extraction review quarantined this uncertain value.",
      );
    }

    if (Array.isArray(correction.lineItems)) {
      const visibleText = getVisibleTextFromMarkdown(nextDoc.md);
      const reviewedLineItems = options.authoritative
        ? sanitizeLineItems(correction.lineItems)
        : normalizeExtractedCommercialLineItems({
            docType: nextDoc.type,
            lineItems: sanitizeLineItems(correction.lineItems),
            visibleTextPages: visibleText ? [visibleText] : [],
            documentFields: nextDoc.fields,
          });
      if (
        !options.authoritative &&
        reviewedLineItems.length === 0 &&
        nextDoc.lineItems?.length &&
        isCommercialDocType(nextDoc.type) &&
        hasVisibleCommercialItemTable(nextDoc)
      ) {
        warnings.push(
          `Ignored an empty line-item replacement for ${docId}: the source still contains a commercial item table. Existing rows require review.`,
        );
      } else {
        nextDoc.lineItems = reviewedLineItems;
        lineItemsReplaced = true;
      }
    }

    const preservedWeights = options.authoritative
      ? { document: nextDoc, restoredFields: [] as FieldKey[] }
      : preserveSourceSupportedWeighmentTriple(
          originalDoc,
          nextDoc,
          originalQualityIssueCount,
        );
    nextDoc = preservedWeights.document;
    if (preservedWeights.restoredFields.length) {
      const restored = new Set<string>(preservedWeights.restoredFields);
      changedFields.splice(
        0,
        changedFields.length,
        ...changedFields.filter((field) => !restored.has(field)),
      );
      unsetFields.splice(
        0,
        unsetFields.length,
        ...unsetFields.filter((field) => !restored.has(field)),
      );
      quarantinedFields.splice(
        0,
        quarantinedFields.length,
        ...quarantinedFields.filter((field) => !restored.has(field)),
      );
      warnings.push(
        `Ignored review weight changes for ${docId}: the original gross, tare, and net values reconcile and the written net weight confirms them.`,
      );
    }

    if (
      documentType ||
      changedFields.length ||
      unsetFields.length ||
      quarantinedFields.length ||
      lineItemsReplaced
    ) {
      if (!options.authoritative) {
        nextDoc.fields = sanitizeFieldsForDocType(
          nextDoc.type,
          nextDoc.fields,
        ) as Partial<Record<FieldKey, string>>;
      }
      nextDoc.md = rebuildReviewedMarkdown(nextDoc, originalDoc.md);
      correctedById.set(docId, nextDoc);
      applied.push({
        docId,
        title: nextDoc.title,
        ...(reason ? { reason } : {}),
        changedFields,
        unsetFields,
        quarantinedFields,
        ...(documentType ? { documentType } : {}),
        ...(lineItemsReplaced ? { lineItemsReplaced } : {}),
      });
    }
  }

  return {
    documents: documents.map((doc) => correctedById.get(doc.id) ?? doc),
    summary: {
      enabled: true,
      required: true,
      reviewedAt: new Date().toISOString(),
      model: getExtractionReviewModel(),
      provider: getExtractionReviewProvider(),
      reasoningEffort: getExtractionReviewReasoningEffort(),
      correctionCount: applied.length,
      reviewIssueCount: 0,
      corrections: applied,
      warnings: [
        ...warnings,
        ...normalizeStringArray(payload.notes).map((note) =>
          compactPromptText(note, 400),
        ),
      ].filter(Boolean),
    },
  };
}

function assertAuthoritativeDocumentAuditApplied(
  documents: CaseDoc[],
  audits: AuthoritativeReviewResult["documentAudits"],
) {
  const documentsById = new Map(
    documents.map((document) => [document.id, document]),
  );
  const residualValues: string[] = [];

  for (const audit of audits) {
    const document = documentsById.get(audit.docId);
    if (!document) {
      residualValues.push(`${audit.docId}:missing-document`);
      continue;
    }

    for (const field of audit.unsupportedFields) {
      if (String(document.fields[field] ?? "").trim()) {
        residualValues.push(`${audit.docId}:field:${field}`);
      }
    }

    for (const {
      field,
      value,
      evidence,
      evidenceKind = "printed",
    } of audit.fieldEvidence ?? []) {
      const expectedKind =
        FIELD_DEFINITIONS.find((definition) => definition.key === field)
          ?.evidenceKind ?? "printed";
      if (
        document.fields[field] !== value ||
        !value.trim() ||
        evidence.sourceFileName !== document.sourceFileName ||
        !document.sourcePageNumbers?.includes(evidence.pageNumber) ||
        evidenceKind !== expectedKind ||
        !evidence.quote.trim() ||
        (evidenceKind === "printed" && !evidence.quote.includes(value))
      )
        residualValues.push(`${audit.docId}:paired-field:${field}`);
    }

    for (const property of audit.unsupportedLineItemProperties) {
      const remains = (document.lineItems ?? []).some((lineItem) =>
        Boolean(
          String(
            (lineItem as unknown as Record<string, unknown>)[property] ?? "",
          ).trim(),
        ),
      );
      if (remains) {
        residualValues.push(`${audit.docId}:line-item:${property}`);
      }
    }
  }

  if (residualValues.length) {
    throw new Error(
      `Authoritative review corrections were not preserved in the final documents: ${residualValues.join(", ")}.`,
    );
  }
}

// Staged review uses the same mandatory source contract as whole-packet review.
// These entry points validate complete model responses; they never salvage a
// truncated JSON fragment or infer a field from its spelling.
export function parseValidatedSourceReview(
  raw: string,
  document: CaseDoc,
  sourcePages: ReviewSourcePage[],
) {
  const payload = parseExtractionReviewPayload(
    raw,
    true,
    [document],
    sourcePages,
  );
  const verified = validateAuthoritativeSourceReview(
    payload,
    [document],
    sourcePages,
  );
  const applied = applyExtractionReviewCorrections([document], payload, {
    authoritative: true,
  });
  const pageQuality = parseDocumentPageQuality({
    value: payload.pageQuality,
    sourcePages,
    documents: verified.documents,
  });
  return {
    document: verified.documents[0],
    audit: verified.documentAudits[0],
    pageQuality,
    summary: applied.summary,
  };
}

export function parseValidatedPacketReconciliation(params: {
  raw: string;
  documents: CaseDoc[];
  candidateMismatches: Mismatch[];
  documentAudits: AuthoritativeDocumentAudit[];
  sourcePages: ReviewSourcePage[];
}) {
  const payload = JSON.parse(params.raw) as Record<string, unknown>;
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("Packet reconciliation did not return a JSON object.");
  const ids = new Set(params.documents.map((document) => document.id));
  if (
    params.documentAudits.length !== ids.size ||
    new Set(params.documentAudits.map((audit) => audit.docId)).size !== ids.size
  )
    throw new Error(
      "Packet reconciliation requires a completed source audit for every document.",
    );
  for (const audit of params.documentAudits) {
    const document = params.documents.find((entry) => entry.id === audit.docId);
    if (!document)
      throw new Error("A source audit refers to an unknown document.");
    assertReferenceGrounding({
      document,
      evidence: audit.referenceEvidence,
      sourcePages: params.sourcePages,
    });
  }
  assertAuthoritativeDocumentAuditApplied(
    params.documents,
    params.documentAudits,
  );
  const mismatchReview = parseAuthoritativeMismatchDecisions(
    payload.mismatchDecisions,
    params.candidateMismatches,
  );
  return {
    authoritativeReview: {
      mismatches: mismatchReview.mismatches,
      termsChecklist: parseAuthoritativeTermsChecklist(
        payload.termsChecklist,
        params.documents,
      ),
      verificationGroups: parseAuthoritativePacketGroups(
        payload.packetGroups,
        params.documents,
        true,
      ),
      documentAudits: params.documentAudits,
    } satisfies AuthoritativeReviewResult,
    confirmedMismatchCount: mismatchReview.confirmedCount,
    dismissedMismatchCount: mismatchReview.dismissedCount,
  };
}

export function extractionReviewDocumentPrompt(documents: CaseDoc[]) {
  return buildExtractionReviewPrompt(documents);
}

export function validateMismatchDecisionBatch(
  value: unknown,
  candidates: Mismatch[],
) {
  return parseAuthoritativeMismatchDecisions(value, candidates);
}

export async function reviewAndCorrectExtractedDocuments(
  documents: CaseDoc[],
  options?: {
    candidateDocumentIds?: Iterable<string>;
    candidateMismatches?: Mismatch[];
    preliminaryVerificationGroups?: VerificationGroup[];
    sourcePages?: ReviewSourcePage[];
    authoritativePacketReview?: boolean;
    onReviewStage?: (progress: number, stage: string) => Promise<void>;
  },
): Promise<{
  documents: CaseDoc[];
  review: ExtractionReviewSummary;
  reviewIssues: Mismatch[];
  pageQuality: DocumentPageQualityAssessment[];
  authoritativeReview?: AuthoritativeReviewResult;
}> {
  if (process.env.PACKET_EXTRACTION_REVIEW_ENABLED === "false") {
    if (options?.authoritativePacketReview) {
      throw new Error(
        "Authoritative packet review cannot be disabled. Remove PACKET_EXTRACTION_REVIEW_ENABLED=false.",
      );
    }
    return {
      documents,
      review: {
        enabled: false,
        required: false,
        correctionCount: 0,
        reviewIssueCount: 0,
        corrections: [],
        warnings: [
          "Second-pass extraction review is disabled by PACKET_EXTRACTION_REVIEW_ENABLED=false.",
        ],
      },
      reviewIssues: [],
      pageQuality: [],
    };
  }

  const candidateDocumentIds = new Set(options?.candidateDocumentIds ?? []);
  const sourcePages = options?.sourcePages ?? [];
  const reviewableSourceFiles = new Set(
    sourcePages.map((page) => page.sourceFileName),
  );
  // The reviewer needs the complete packet to distinguish a true conflict from
  // an OCR problem. Restricting it to the initially suspicious page can hide
  // corroborating evidence on an otherwise strong document.
  const assessableDocuments = documents.filter((doc) =>
    Boolean(
      doc.md?.trim() ||
      Object.keys(doc.fields).length ||
      doc.lineItems?.length ||
      (doc.sourceFileName && reviewableSourceFiles.has(doc.sourceFileName)),
    ),
  );
  if (!assessableDocuments.length) {
    if (options?.authoritativePacketReview) {
      throw new Error(
        "Authoritative packet review requires extracted packet evidence.",
      );
    }
    return {
      documents,
      review: {
        enabled: true,
        required: true,
        verdict: "pass",
        attemptCount: 0,
        reviewedAt: new Date().toISOString(),
        model: getExtractionReviewModel(),
        provider: getExtractionReviewProvider(),
        reasoningEffort: getExtractionReviewReasoningEffort(),
        correctionCount: 0,
        reviewIssueCount: 0,
        corrections: [],
        warnings: [
          "Second-pass extraction review skipped because no extracted packet evidence was available.",
        ],
      },
      reviewIssues: [],
      pageQuality: [],
    };
  }

  const authoritativeInstructions = options?.authoritativePacketReview
    ? " You are the final semantic authority for this case. Preliminary extraction, grouping, and mismatches are untrusted proposals. Inspect the entire packet and decide them from the original page images and visible text. Before deciding the packet, perform a source-integrity audit of every document: verify every populated field and every populated line-item property against that same document's own page, remove or correct unsupported values, and add any clearly labelled critical reference that the first pass missed. Return exactly one documentAudit for every document. In each audit, list every unsupported top-level field, every clearly visible but missing critical field, and every unsupported line-item property; use empty lists only after checking the entire page. Mark the audit corrected when you return a correction, verified only when no correction is needed, and needs_review only when the source cannot be decided safely. Packet context may establish relationships and mismatches, but it must never populate a field on a document where that value is not visible. In particular, do not carry invoice tax rates or amounts into delivery notes/challans, do not combine adjacent identifiers and dates, keep freight terms such as PREPAID or TO PAY out of deliveryTerms, and keep PO order dates, delivery schedules, payment terms, and delivery terms in their distinct semantic roles. Return packetGroups that assign every document exactly once. Each packet group label is the final user-facing case name and must use the external counterparty plus the primary invoice or PO reference, for example 'Bridge Metals / BMT-017'. Each group must also contain caseSummary with counterpartyName, poNumber, invoiceNumber, primaryReference, and packetCategory; copy identifiers exactly and use empty strings only when the packet genuinely has no such value. Use relationship seller_chain only when the printed seller-to-buyer sequence proves it; list buyer-facing invoice documents in primaryDocumentIds and upstream documents in contextDocumentIds. Return one mismatchDecision for every candidate mismatch id, using confirmed or dismissed with a concise evidence-based reason. Confirm only a difference that is visibly supported by the supplied source pages; dismiss OCR noise, formatting variants, equivalent values, derivative symptoms, and unsupported candidates. If a page is not readable enough to decide safely, dismiss the unproven commercial candidate and report the page through pageQuality or an extraction reviewIssue so approval remains blocked without presenting a false mismatch. Do not duplicate a candidate mismatch in reviewIssues. For every decision, set primary true only when that mismatch is the root business discrepancy rather than a downstream numerical symptom. When printed quantities differ but each document's GST rate and tax arithmetic are internally correct, the quantity conflict is primary; do not present the resulting amount difference as an independent tax error. Set outlierDocumentIds only to source documents whose printed value conflicts with the best-supported packet evidence; use an empty array when the direction cannot be established. Return a complete termsChecklist covering every explicit, packet-testable clause. A required document is missing only after checking every document in the packet; generic wording such as statutory transport documents can be satisfied by appropriate visible transport evidence even when the wording differs. Keep unknown obligations in the checklist without turning them into mismatches. Every correction must include evidence with sourceFileName, pageNumber, and an exact visible quote. Do not put calculated or inferred values into extracted fields; explain arithmetic only in reasoning. This response becomes canonical and no semantic parser, regex, heuristic, or enrichment step will alter it afterward. "
    : "";
  const systemContent =
    "You are a strict procurement packet extraction reviewer. Return only JSON. " +
    "Review all extracted documents against their visibleText and correct only values that are explicitly supported by visible packet evidence. " +
    "Treat each document as its own source ledger: a field or line-item property is valid only when it is visible on that document's own page. Use other pages to compare values, never to fill a missing value. Audit all existing values, not only candidate mismatches. " +
    "Semantic grounding is more than finding the same words on a page. First identify the meaning of the printed label and the role of its adjacent value, then decide the destination field. A document category, title, date, party name, or another reference is not an identifier merely because it is printed nearby. Use referenceFieldDefinitions as field meanings, not as literal label-matching rules; reason about the layout, handwriting and synonyms. Remove a mis-mapped value when its actual role does not support the reference field, and leave physically blank references absent. " +
    "Do not invent data from file names, nearby documents, expectations, or arithmetic alone. " +
    "Invoice number is mandatory for approval of each buyer-facing invoice. When its number is visibly blank or absent, leave invoiceNumber empty; never substitute a PO, e-way bill, LR, delivery reference, or a number from another page. The application enforces this requirement after your source audit; do not invent a number to make the case approvable. Do not propose a null correction for an already absent value. visibleOmittedFields means a clearly printed value that extraction skipped, not a physically blank field. " +
    "You may correct documentType, fields, lineItems, quarantine unsupported fields, and report unresolved reviewIssues. " +
    "Use the packet-level allowedFieldKeys list for valid output keys. During the completeness audit, correct an explicitly labelled visible value only when it is missing or mapped to the wrong valid field. Do not require every allowed field to be present. " +
    "Use the entire packet as context. A value may be valid visible evidence even when its format is invalid; never silently discard such evidence. Create a reviewIssue only for a genuine unresolved conflict between explicit source values, or for an unreadable or truncated critical identifier or amount that makes approval unsafe. Never create a reviewIssue for a missing optional field, harmless formatting, low confidence alone, or a problem fully resolved by a correction. A clean, internally consistent packet must have an empty reviewIssues array. " +
    "Perform a separate visual readability audit for every supplied original source page. The supplied page view may already have been rotated into its natural reading orientation by a separate visual model; that corrected orientation is not a quality defect. A materially faint, blurred, cropped, or unreadable page is not approval-safe even if OCR produced plausible values. Minor skew or low contrast is clear only when every critical value remains comfortably readable. Decide page quality from the page image itself, never from OCR confidence or filename. " +
    "Keep the JSON compact. Return only actual corrections, never repeat unchanged fields or unchanged lineItems, keep each reason to at most two short sentences, quote only the minimum exact evidence needed, and leave notes empty unless they contain a material warning not represented elsewhere. " +
    "Do not replace a correct field or table merely to change decimal padding, letter case, or numeric formatting. Preserve the original extracted value when it conveys the same visible value and unit; still correct genuinely wrong digits, units or roles. " +
    "For every Invoice or Tax Invoice with a visible commercial item table, ensure lineItems contains every visible goods or service row. Do not move an invoice row to another document merely because the same HSN or amount also appears there. " +
    "Omit lineItems when no row correction is needed; never send an empty array as a no-change placeholder. When correcting rows, return the complete table. Keep dimensions and material grades in description; itemCode is only the explicitly printed product code. " +
    "E-Way Bill numbers must be exactly 12 digits. If an extracted eWayBillNumber is not 12 digits, remove it from trusted fields and add a reviewIssue containing the visible source value unless visible evidence supports a correction. " +
    "Do not automatically move an invalid e-way value into referenceInvoiceNumber unless the visible page explicitly labels it as Doc No, Document No, Invoice No, Tax Invoice No, or Delivery Challan No for that same document. " +
    "If a page is a PASS OUT DOCUMENT, delivery summary, logistics summary, or contains multiple delivery refs such as EM5032/EM5033, avoid creating a strong invoice reference unless the label and line amounts clearly support that exact invoice. " +
    "Do not confuse the billed buyer with a separate consignee/ship-to party. " +
    "A seller-chain packet may legitimately contain an upstream supplier invoice and a separate buyer-facing invoice. Preserve each invoice's printed seller, buyer, invoice number, quantities, taxes, and totals; never rewrite the upstream invoice merely to make it agree with the buyer-facing invoice. Printed copies of one invoice should remain consistent evidence, while genuinely different invoices must remain separate. " +
    "Keep explicitly labelled DO No or Delivery Order No in deliveryOrderNumber. Keep Delivery Note No, Challan No, or a separately labelled Delivery No in deliveryNoteNumber. These are distinct references and must not overwrite one another. " +
    "On invoices, accept a PO reference only when the same value is explicitly labelled PO No, P.O. No, Purchase Order No, Buyer PO, or Order No. Never copy SO No, DO No, Delivery No, or a delivery-order number into referencePoNumber. " +
    "On invoices, an explicitly labelled LR No, LR/RR No, Consignment Note No, or Transporter Doc No is valid lorryReceiptNumber evidence; do not remove it merely because it is a logistics reference. " +
    "On invoices, put Freight, Freight Terms, Freight Status, PREPAID, PAID, or TO PAY wording in freightTerms when it describes freight. Do not put that wording in deliveryTerms; reserve deliveryTerms for schedules, destinations, lead times, dispatch conditions, and delivery bases. " +
    "On weighment slips, the page-header company is the weighbridgeName; use a separately labelled CUSTOMER or PARTY value as vendorName. Confirm gross minus tare equals net and preserve trailing zeroes confirmed by a written-out net weight. When all three source values are readable but the equation fails, preserve them exactly as printed and confirm the weight-calculation candidate; never remove or rewrite a weight merely to make the equation balance. " +
    "On weighment slips, preserve a separately labelled LR No, Lorry Receipt, Consignment Note, or Transporter Doc No in lorryReceiptNumber; never substitute the weighment ticket number or vehicle number. " +
    "On lorry receipts, vendorName is the explicitly labelled Consignor, not the carrier, loading point, or booking office. An explicitly labelled GST Invoice Value or Invoice Value is valid totalAmount evidence for packet comparison; do not remove it merely because it is not freight or the carrier's charge. " +
    "When an invoice line's quantity multiplied by its rate does not reconcile with its taxable amount, re-read the table headers. Distinguish pieces, bags, and bundles from billed weight. If the rate is per KG, MT, TO, or tonne, return the visibly supported weight quantity and matching unit. " +
    "When an invoice separately prints MATERIAL VALUE and FREIGHT VALUE, keep MATERIAL VALUE as the goods line's taxableAmount and keep FREIGHT VALUE in freightAmount; the document subtotal may include both. Do not copy the document-wide subtotal or tax amount into the goods line. " +
    "For GST, preserve visible tax percentages separately from tax amounts. Do not assume a home state; use visible taxes and both parties’ GSTINs. " +
    (options?.authoritativePacketReview
      ? "For every documentAudit, include supportedFields and unsupportedFields that partition every populatedFieldKey exactly once. Also include supportedLineItemProperties and unsupportedLineItemProperties that partition every populatedLineItemProperty exactly once. Do not skip a populated key and do not list it in both groups. Compare every visibly printed label against that document's allowedFieldKeys and correct any clearly visible missing critical value. The structured caseSummary is authoritative for naming: counterpartyName must identify the external party and primaryReference must identify the primary invoice or purchase order. "
      : "") +
    authoritativeInstructions +
    (options?.authoritativePacketReview
      ? "Return one compact JSON object exactly following the supplied response schema. sourceSupport is keyed by docId and covers only the NON-REFERENCE fields and line-item properties named in sourceSupportChecklist, each with one supported/unsupported verdict. Audit the ORIGINAL proposals, not the corrected field set. Do not add absent fields to these maps. Use visibleOmittedFields with an actual populated value, own-page evidence and correction only for newly found NON-REFERENCE values; never for blank source fields. Return one documentAudit per document with sourceVerdict verified when its source can be decided safely, or needs_review when it cannot. sourceVerdict describes source decidability, NOT whether extraction was changed. Do not supply audit status or a top-level verdict; the app derives corrected/verified and the overall verdict from your source-grounded decisions and actual changes. Return one pageQuality per original page. Use sparse correction fields only for NON-REFERENCE changes; all references belong solely in referenceReviews. Keep reasons/quotes brief and do not repeat unchanged tables. Use empty page issues only for clear upright pages and approvalSafe false whenever issues are nonempty. "
      : 'Return JSON shape: {"verdict":"pass|corrected|needs_review","corrections":[{"docId":"...","documentType":"Invoice","fields":[{"field":"fieldKey","value":"value or null"}],"unsetFields":["fieldKey"],"quarantineFields":[{"field":"fieldKey","reason":"..."}],"lineItems":[...],"reason":"concise evidence"}],"reviewIssues":[{"field":"fieldKey","evidence":[{"docId":"...","value":"exact visible value"}],"reason":"concise unresolved conflict or uncertainty"}],"notes":["..."]}. Use the sparse fields array only for actual changes. ') +
    (options?.authoritativePacketReview
      ? "referenceReviews is the ONLY authority for reference values. Return exactly one {docId,fields} entry per document. fields is keyed by the canonical reference field. Each entry contains its FINAL value (string or null) TOGETHER with sourceLabel, valueKind, sourceFileName, pageNumber and quote. Include EVERY reference in referenceReviewChecklist and any newly found reference. Keep a correct reference by repeating its value with proof; remove a mis-mapped, absent or unreadable reference with null and its actual source meaning. A non-null value requires valueKind reference and sourceLabel plus that exact value verbatim in its brief OWN-page quote. Use sourcePageNumbers; never transfer IDs between sources. Do not return separate referenceEvidence or reference changes in corrections: the app materializes the ledger itself. In caseSummary, select counterpartySource {docId,field} for the verified external party, or null if unknown. DO NOT copy counterpartyName: the app reads the selected field exactly. For purchases choose supplier vendorName on the primary buyer-facing invoice or PO, not buyerName, shipToName, a carrier or upstream context invoice. The PO issuer is the purchaser. Summary invoiceNumber and poNumber must be retained ledger references from this group. primaryReference must equal one of those summary references, or be empty if both are absent. "
      : "") +
    (options?.authoritativePacketReview
      ? "Always include corrections and reviewIssues, with empty arrays when no non-reference changes or unresolved extraction findings remain. "
      : "Always include verdict, corrections, and reviewIssues. Use verdict pass only when no extraction correction, unresolved evidence, confirmed mismatch, or unfulfilled obligation remains; use corrected when corrections fully resolve the packet; use needs_review when any unresolved or blocking issue remains. ") +
    "Use null in fields or quarantineFields to remove unsupported values. Use empty corrections when extraction is already strong.";

  const reviewContext = JSON.stringify({
    allowedDocumentTypes: SUPPORTED_DOC_TYPES,
    allowedFieldKeys: ALL_ALLOWED_FIELD_KEYS,
    referenceFieldDefinitions: REFERENCE_FIELD_DEFINITIONS.map(
      ({ key, label }) => ({ key, meaning: label }),
    ),
    counterpartySourceFields: COUNTERPARTY_SOURCE_FIELDS,
    sourceSupportChecklist:
      buildReviewSourceSupportChecklist(assessableDocuments),
    referenceReviewChecklist: Object.fromEntries(
      assessableDocuments.map((document) => [
        document.id,
        REFERENCE_FIELD_DEFINITIONS.filter(({ key }) =>
          String(document.fields[key] ?? "").trim(),
        ).map(({ key }) => key),
      ]),
    ),
    candidateMismatches: (options?.candidateMismatches ?? []).map(
      (mismatch, index) => ({
        id: authoritativeMismatchReviewId(index),
        field: mismatch.field,
        values: mismatch.values.map((entry) => ({
          docId: entry.docId,
          value: entry.value,
        })),
        analysis: mismatch.analysis,
      }),
    ),
    preliminaryVerificationGroups: options?.preliminaryVerificationGroups ?? [],
    documents: buildExtractionReviewPrompt(assessableDocuments).map(
      (document) => ({
        ...document,
        reviewPriority: candidateDocumentIds.has(document.docId),
      }),
    ),
  });
  const reviewRequestText =
    "Review this completed first-pass extraction before persistence. " +
    "Candidate mismatches and packet groups are machine-generated review targets, not established facts. " +
    "For each target, reason about document roles, OCR variants, equivalent units, formatting, arithmetic, and all packet evidence before deciding. " +
    "Do not erase a real difference merely to make the documents agree. Only return corrections supported by source evidence.\n\n" +
    reviewContext;
  const userContent = sourcePages.length
    ? [
        { type: "text" as const, text: reviewRequestText },
        ...sourcePages.flatMap((page) => [
          {
            type: "text" as const,
            text: `Original source page: ${page.sourceFileName}, page ${page.pageNumber}`,
          },
          { type: "image_url" as const, image_url: { url: page.image } },
        ]),
      ]
    : reviewRequestText;

  const messages = [
    {
      role: "system",
      content: systemContent,
    },
    {
      role: "user",
      content: userContent,
    },
  ] as Parameters<typeof callExtractionReviewModel>[0];

  let payload:
    | (ExtractionReviewPayload & {
        verdict: ExtractionReviewVerdict;
        corrections: unknown[];
        reviewIssues: unknown[];
      })
    | null = null;
  let attemptCount = 0;
  let formatError = "";
  let rejectedReviewResponse = "";
  let authoritativeReview:
    | (AuthoritativeReviewResult & {
        confirmedMismatchCount: number;
        dismissedMismatchCount: number;
      })
    | undefined;
  let pageQuality: DocumentPageQualityAssessment[] = [];
  while (attemptCount < 2 && !payload) {
    attemptCount += 1;
    const attemptMessages =
      attemptCount === 1
        ? messages
        : [
            ...messages,
            { role: "assistant" as const, content: rejectedReviewResponse },
            {
              role: "user" as const,
              content:
                "Repair your previous review response against the original sources and the required JSON contract. The previous response is untrusted; preserve only source-supported findings and correct the specific defect rather than restarting the packet review from scratch. " +
                `Problem: ${formatError} Return one complete, compact JSON object now. Do not repeat unchanged fields or tables; keep every reason and evidence quote brief. Include every required top-level property, with empty arrays where there are no findings.`,
            },
          ];
    const raw = await callExtractionReviewModel(attemptMessages, {
      operation: "extraction-review",
      responseSchema:
        options?.authoritativePacketReview && PACKET_STRICT_REVIEW_SCHEMA
          ? {
              name: "samrat_authoritative_review",
              strict: true,
              schema: buildAuthoritativeReviewResponseSchema({
                documentCount: assessableDocuments.length,
                mismatchCount: options.candidateMismatches?.length ?? 0,
                pageCount: sourcePages.length,
                documents: assessableDocuments,
              }),
            }
          : undefined,
    });
    try {
      const parsed = parseExtractionReviewPayload(
        raw,
        options?.authoritativePacketReview,
        options?.authoritativePacketReview ? assessableDocuments : undefined,
        sourcePages,
      );
      authoritativeReview = options?.authoritativePacketReview
        ? parseAuthoritativeReviewResult(
            parsed,
            assessableDocuments,
            options.candidateMismatches ?? [],
            sourcePages,
          )
        : undefined;
      pageQuality = options?.authoritativePacketReview
        ? parseDocumentPageQuality({
            value: parsed.pageQuality,
            sourcePages,
            documents: assessableDocuments,
          })
        : [];
      payload = parsed;
    } catch (error) {
      rejectedReviewResponse = raw;
      formatError =
        error instanceof Error
          ? error.message
          : String(error ?? "Invalid review response");
      console.warn("[extraction-review] Review contract rejected", {
        attempt: attemptCount,
        reason: formatError,
      });
    }
  }
  if (!payload) {
    throw new ReviewContractError(
      `Required extraction review failed after ${attemptCount} attempts. ${formatError}`,
    );
  }
  if (options?.authoritativePacketReview) {
    await options.onReviewStage?.(
      94,
      "Independently verifying AI review against source pages",
    );
  }
  // One strong, source-grounded review is the normal path. The former default
  // immediately replayed every page through a second sequential model call,
  // even though the authoritative reviewer had already audited those pages.
  // Keep the deeper audit available for exceptional investigations without
  // charging every ordinary case the same latency.
  const independentValidation =
    options?.authoritativePacketReview &&
    process.env.PACKET_INDEPENDENT_REVIEW_ENABLED === "true"
      ? await independentlyValidateAuthoritativeReview({
          payload,
          documents: assessableDocuments,
          sourcePages,
          primaryPageQuality: pageQuality,
        })
      : undefined;
  if (independentValidation) {
    pageQuality = independentValidation.pageQuality;
    await options?.onReviewStage?.(97, "Reconciling both AI reviews");
  }
  const verifiedPayload = independentValidation
    ? { ...payload, corrections: independentValidation.corrections }
    : payload;
  const applied = applyExtractionReviewCorrections(
    assessableDocuments,
    verifiedPayload,
    // The strict source audit above has already decided every populated field
    // and line-item property. Preserve that canonical decision exactly instead
    // of routing reviewed values back through first-pass semantic enrichment.
    { authoritative: Boolean(authoritativeReview) },
  );
  if (authoritativeReview) {
    assertAuthoritativeDocumentAuditApplied(
      applied.documents,
      authoritativeReview.documentAudits,
    );
  }
  const primaryReviewIssues = buildEvidenceBackedExtractionReviewIssues(
    applied.documents,
    payload.reviewIssues,
  );
  const reviewIssues = [
    ...(independentValidation?.reviewIssues ?? primaryReviewIssues),
    ...buildDocumentReadabilityMismatches(pageQuality),
  ];
  applied.summary.reviewIssueCount = reviewIssues.length;
  applied.summary.attemptCount = attemptCount;
  const actionableTermsCount =
    authoritativeReview?.termsChecklist.filter(
      (item) => item.status === "not_fulfilled",
    ).length ?? 0;
  applied.summary.authoritative = Boolean(authoritativeReview);
  applied.summary.semanticPostProcessing = false;
  applied.summary.candidateMismatchCount =
    options?.candidateMismatches?.length ?? 0;
  applied.summary.confirmedMismatchCount =
    authoritativeReview?.confirmedMismatchCount ?? 0;
  applied.summary.dismissedMismatchCount =
    authoritativeReview?.dismissedMismatchCount ?? 0;
  applied.summary.termsChecklistCount =
    authoritativeReview?.termsChecklist.length ?? 0;
  applied.summary.packetGroupCount =
    authoritativeReview?.verificationGroups.length ?? 0;
  const primaryCorrectionMutationCount = buildCorrectionMutationCandidates(
    payload,
    assessableDocuments,
  ).length;
  applied.summary.proposedCorrectionMutationCount =
    independentValidation?.proposedCount ?? primaryCorrectionMutationCount;
  applied.summary.verifiedCorrectionMutationCount =
    independentValidation?.verifiedCount ?? primaryCorrectionMutationCount;
  applied.summary.rejectedCorrectionMutationCount =
    independentValidation?.rejectedCount ?? 0;
  applied.summary.unresolvedCorrectionMutationCount =
    independentValidation?.unresolvedCount ?? 0;
  applied.summary.proposedReviewIssueCount =
    independentValidation?.proposedReviewIssueCount ??
    primaryReviewIssues.length;
  applied.summary.verifiedReviewIssueCount =
    independentValidation?.verifiedReviewIssueCount ??
    primaryReviewIssues.length;
  applied.summary.dismissedReviewIssueCount =
    independentValidation?.dismissedReviewIssueCount ?? 0;
  applied.summary.unresolvedReviewIssueCount =
    independentValidation?.unresolvedReviewIssueCount ?? 0;
  applied.summary.independentPageQualityReview = Boolean(independentValidation);
  applied.summary.documentAudits = authoritativeReview?.documentAudits ?? [];
  applied.summary.warnings.push(...(independentValidation?.warnings ?? []));
  applied.summary.verdict =
    reviewIssues.length ||
    (authoritativeReview?.confirmedMismatchCount ?? 0) > 0 ||
    actionableTermsCount > 0
      ? "needs_review"
      : applied.summary.correctionCount
        ? "corrected"
        : "pass";
  const correctedById = new Map(applied.documents.map((doc) => [doc.id, doc]));
  return {
    documents: documents.map((doc) => correctedById.get(doc.id) ?? doc),
    review: applied.summary,
    reviewIssues,
    pageQuality,
    ...(authoritativeReview ? { authoritativeReview } : {}),
  };
}

function mapFields(
  fields: Record<string, unknown>,
  docType?: DocType,
): Partial<Record<FieldKey, string>> {
  const result: Partial<Record<FieldKey, string>> = {};
  const allowedFieldKeys = docType
    ? getAllowedFieldKeysForDocType(docType)
    : ALL_ALLOWED_FIELD_KEYS;

  allowedFieldKeys.forEach((fieldKey) => {
    const aliases = FIELD_MAPPINGS[fieldKey] ?? [];
    for (const alias of aliases) {
      const value = fields[alias];
      const normalizedValue = normalizeFieldValue(value);
      if (
        normalizedValue &&
        shouldAcceptMappedAlias(fieldKey, alias, normalizedValue)
      ) {
        result[fieldKey] = normalizedValue;
        break;
      }
    }
  });

  if (!result.subtotal && result.totalTaxableAmount) {
    result.subtotal = result.totalTaxableAmount;
  }
  if (
    docType === "E-Way Bill" &&
    !result.totalTaxableAmount &&
    result.subtotal
  ) {
    result.totalTaxableAmount = result.subtotal;
  }

  return docType
    ? (sanitizeFieldsForDocType(docType, result) as Partial<
        Record<FieldKey, string>
      >)
    : (omitIgnoredFields(result) as Partial<Record<FieldKey, string>>);
}

function mergeFieldRecords(
  primary: Partial<Record<FieldKey, string>>,
  fallback: Partial<Record<FieldKey, string>>,
) {
  return {
    ...fallback,
    ...Object.fromEntries(
      Object.entries(primary).filter(
        ([, value]) =>
          value !== undefined && value !== null && String(value).trim(),
      ),
    ),
  } as Partial<Record<FieldKey, string>>;
}

function mergeExtractedDocs(primary: CaseDoc, fallback: CaseDoc): CaseDoc {
  return {
    ...primary,
    fields: mergeFieldRecords(primary.fields, fallback.fields),
    lineItems: primary.lineItems?.length
      ? primary.lineItems
      : fallback.lineItems,
    md: primary.md?.trim() ? primary.md : fallback.md,
  };
}

const INVOICE_COPY_LABEL_PATTERN =
  /\b(?:(?:original|duplicate|triplicate|quadruplicate)(?:\s+(?:for|to))?(?:\s+(?:recipient|buyer|customer|transporter|supplier|seller))?|(?:buyer|seller|supplier|recipient|customer|transporter|office|extra)\s+copy|copy\s+(?:for|to)?\s*(?:buyer|seller|supplier|recipient|customer|transporter))\b/i;
const INVOICE_COPY_TOKEN_PATTERN =
  /\b(?:original|duplicate|triplicate|quadruplicate|copy|customer|buyer|seller|supplier|recipient|transporter|office|extra|for|to)\b/g;
const INVOICE_COPY_MIN_COMMON_TOKENS = 25;
const INVOICE_COPY_SIMILARITY_THRESHOLD = 0.82;
const INVOICE_COPY_LINE_OVERLAP_THRESHOLD = 0.6;
const INVOICE_AMOUNT_IDENTITY_FIELDS: FieldKey[] = [
  "totalAmount",
  "subtotal",
  "taxAmount",
];
const INVOICE_LINE_ITEM_KEYS: Array<keyof CommercialLineItem> = [
  "lineNumber",
  "itemCode",
  "description",
  "hsnSac",
  "quantity",
  "unit",
  "rate",
  "discountPercent",
  "netRate",
  "taxableAmount",
  "cgstRate",
  "cgstAmount",
  "sgstRate",
  "sgstAmount",
  "igstRate",
  "igstAmount",
  "taxRate",
  "taxAmount",
  "lineTotal",
  "referencePoLineNumber",
  "rawText",
  "sourcePage",
];

function getInvoiceCopyText(doc: CaseDoc) {
  return [doc.title, doc.sourceFileName, doc.sourceHint, doc.md]
    .filter(Boolean)
    .join("\n");
}

function hasInvoiceCopyLabel(doc: CaseDoc) {
  return INVOICE_COPY_LABEL_PATTERN.test(getInvoiceCopyText(doc));
}

function getInvoiceCopyRank(doc: CaseDoc) {
  const text = getInvoiceCopyText(doc);
  if (
    /\b(?:original(?:\s+(?:for|to))?\s*(?:recipient|buyer|customer)?|recipient\s+copy|buyer\s+copy|customer\s+copy)\b/i.test(
      text,
    )
  ) {
    return 0;
  }
  if (
    /\b(?:duplicate(?:\s+(?:for|to))?\s*(?:transporter|buyer|customer)?|transporter\s+copy)\b/i.test(
      text,
    )
  ) {
    return 1;
  }
  if (
    /\b(?:triplicate(?:\s+(?:for|to))?\s*(?:supplier|seller)?|supplier\s+copy|seller\s+copy)\b/i.test(
      text,
    )
  ) {
    return 2;
  }
  if (/\b(?:quadruplicate|office\s+copy|extra\s+copy)\b/i.test(text)) {
    return 3;
  }
  return 4;
}

function normalizeInvoiceCopyTokens(value: string) {
  return new Set(
    value
      .toLowerCase()
      .replace(INVOICE_COPY_TOKEN_PATTERN, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1),
  );
}

function compareTokenSets(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return { score: 0, common: 0 };

  let common = 0;
  for (const token of left) {
    if (right.has(token)) common += 1;
  }

  const union = left.size + right.size - common;
  return { score: union > 0 ? common / union : 0, common };
}

function compareInvoiceCopyText(left: CaseDoc, right: CaseDoc) {
  return compareTokenSets(
    normalizeInvoiceCopyTokens(getInvoiceCopyText(left)),
    normalizeInvoiceCopyTokens(getInvoiceCopyText(right)),
  );
}

function normalizeInvoiceIdentity(value?: string) {
  const normalized = normalizePacketValue(value, "invoiceNumber")
    ?.toLowerCase()
    .replace(/\s+/g, "");
  if (!normalized) return null;

  const compact = normalized.replace(/[^a-z0-9]/g, "");
  if (compact.length < 3 || !/\d/.test(compact)) return null;
  return compact;
}

function normalizeGstinIdentity(value?: string) {
  const normalized = normalizePacketValue(value)
    ?.replace(/[^A-Z0-9]/gi, "")
    .toUpperCase();
  return normalized && normalized.length >= 10 ? normalized : null;
}

function hasMatchingInvoiceGstin(left: CaseDoc, right: CaseDoc) {
  const leftSupplier = normalizeGstinIdentity(left.fields.supplierGstin);
  const rightSupplier = normalizeGstinIdentity(right.fields.supplierGstin);
  const leftBuyer = normalizeGstinIdentity(left.fields.buyerGstin);
  const rightBuyer = normalizeGstinIdentity(right.fields.buyerGstin);

  return Boolean(
    (leftSupplier && rightSupplier && leftSupplier === rightSupplier) ||
    (leftBuyer && rightBuyer && leftBuyer === rightBuyer),
  );
}

function hasMatchingInvoiceAmount(left: CaseDoc, right: CaseDoc) {
  return INVOICE_AMOUNT_IDENTITY_FIELDS.some((field) => {
    const leftAmount = parseLooseNumber(left.fields[field]);
    const rightAmount = parseLooseNumber(right.fields[field]);
    if (
      leftAmount === null ||
      rightAmount === null ||
      leftAmount <= 0 ||
      rightAmount <= 0
    )
      return false;
    return numbersClose(
      leftAmount,
      rightAmount,
      Math.max(1, Math.abs(leftAmount) * 0.002),
    );
  });
}

function normalizeInvoiceLineText(value: unknown) {
  if (value === undefined || value === null) return null;
  const text = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return text || null;
}

function normalizeInvoiceLineAmount(value: unknown) {
  const parsed = parseLooseNumber(
    typeof value === "string" || typeof value === "number" ? value : undefined,
  );
  return parsed === null
    ? normalizeInvoiceLineText(value)
    : formatNumberForField(parsed);
}

function buildInvoiceLineCopySignature(item: CommercialLineItem) {
  const productParts = [
    normalizeInvoiceLineText(item.itemCode),
    normalizeInvoiceLineText(item.hsnSac),
    normalizeInvoiceLineText(item.description),
  ].filter(Boolean);
  const commercialParts = [
    normalizeInvoiceLineAmount(item.quantity),
    normalizeInvoiceLineText(item.unit),
    normalizeInvoiceLineAmount(item.rate),
    normalizeInvoiceLineAmount(item.taxableAmount ?? item.lineTotal),
  ].filter(Boolean);

  if (!productParts.length || !commercialParts.length) return null;
  return [...productParts, ...commercialParts].join("|");
}

function compareInvoiceLineItems(left: CaseDoc, right: CaseDoc) {
  const leftSignatures = new Set(
    sanitizeLineItems(left.lineItems ?? [])
      .map(buildInvoiceLineCopySignature)
      .filter((signature): signature is string => Boolean(signature)),
  );
  const rightSignatures = new Set(
    sanitizeLineItems(right.lineItems ?? [])
      .map(buildInvoiceLineCopySignature)
      .filter((signature): signature is string => Boolean(signature)),
  );

  return compareTokenSets(leftSignatures, rightSignatures);
}

function mergeInvoiceLineItem(
  primary: CommercialLineItem,
  fallback: CommercialLineItem,
) {
  const next = { ...primary };

  for (const key of INVOICE_LINE_ITEM_KEYS) {
    if (
      (next[key] === undefined ||
        next[key] === null ||
        String(next[key]).trim() === "") &&
      fallback[key] !== undefined
    ) {
      next[key] = fallback[key] as never;
    }
  }

  return next;
}

function mergeInvoiceCopyLineItems(
  primary: CommercialLineItem[] | undefined,
  fallback: CommercialLineItem[] | undefined,
) {
  const result: CommercialLineItem[] = [];
  const indexBySignature = new Map<string, number>();

  for (const item of sanitizeLineItems([
    ...(primary ?? []),
    ...(fallback ?? []),
  ])) {
    const signature = buildInvoiceLineCopySignature(item);
    const existingIndex = signature
      ? indexBySignature.get(signature)
      : undefined;

    if (existingIndex !== undefined) {
      result[existingIndex] = mergeInvoiceLineItem(result[existingIndex], item);
      continue;
    }

    const nextIndex = result.push(item) - 1;
    if (signature) indexBySignature.set(signature, nextIndex);
  }

  return result;
}

function getInvoiceDocCompletenessScore(doc: CaseDoc) {
  const fields = countMeaningfulFields(doc.fields);
  const lineItems = sanitizeLineItems(doc.lineItems ?? []).length;
  const amountFields = INVOICE_AMOUNT_IDENTITY_FIELDS.filter(
    (field) => doc.fields[field],
  ).length;
  const textScore = Math.min(6, Math.floor((doc.md?.trim().length ?? 0) / 500));
  return fields * 4 + lineItems * 10 + amountFields * 3 + textScore;
}

function shouldPreferInvoiceCopyCandidate(
  candidate: CaseDoc,
  current: CaseDoc,
) {
  const candidateScore = getInvoiceDocCompletenessScore(candidate);
  const currentScore = getInvoiceDocCompletenessScore(current);
  if (Math.abs(candidateScore - currentScore) >= 12)
    return candidateScore > currentScore;

  const candidateRank = getInvoiceCopyRank(candidate);
  const currentRank = getInvoiceCopyRank(current);
  if (candidateRank !== currentRank) return candidateRank < currentRank;

  return candidateScore > currentScore;
}

function areDuplicateInvoiceCopies(left: CaseDoc, right: CaseDoc) {
  const leftInvoice = normalizeInvoiceIdentity(left.fields.invoiceNumber);
  const rightInvoice = normalizeInvoiceIdentity(right.fields.invoiceNumber);
  const invoiceMatches = Boolean(
    leftInvoice && rightInvoice && leftInvoice === rightInvoice,
  );
  const amountMatches = hasMatchingInvoiceAmount(left, right);
  const gstinMatches = hasMatchingInvoiceGstin(left, right);
  const textMatch = compareInvoiceCopyText(left, right);
  const lineMatch = compareInvoiceLineItems(left, right);
  const strongTextMatch =
    textMatch.common >= INVOICE_COPY_MIN_COMMON_TOKENS &&
    textMatch.score >= INVOICE_COPY_SIMILARITY_THRESHOLD;
  const lineItemsOverlap =
    lineMatch.common > 0 &&
    lineMatch.score >= INVOICE_COPY_LINE_OVERLAP_THRESHOLD;
  const copyEvidence =
    hasInvoiceCopyLabel(left) ||
    hasInvoiceCopyLabel(right) ||
    strongTextMatch ||
    lineItemsOverlap;

  if (invoiceMatches) {
    return (
      copyEvidence &&
      (amountMatches || gstinMatches || strongTextMatch || lineItemsOverlap)
    );
  }

  return (
    copyEvidence &&
    amountMatches &&
    gstinMatches &&
    (strongTextMatch || lineItemsOverlap)
  );
}

function mergeInvoiceCopyDocuments(primary: CaseDoc, fallback: CaseDoc) {
  const merged = mergeExtractedDocs(primary, fallback);
  return {
    ...merged,
    fields: mergeFieldRecords(primary.fields, fallback.fields),
    lineItems: mergeInvoiceCopyLineItems(primary.lineItems, fallback.lineItems),
    md: primary.md?.trim() ? primary.md : fallback.md,
  };
}

function collapseDuplicateInvoiceCopies(documents: CaseDoc[]) {
  const result: CaseDoc[] = [];

  for (const document of documents) {
    if (!isInvoiceDocType(document.type)) {
      result.push(document);
      continue;
    }

    const existingIndex = result.findIndex(
      (candidate) =>
        isInvoiceDocType(candidate.type) &&
        areDuplicateInvoiceCopies(candidate, document),
    );

    if (existingIndex === -1) {
      result.push(document);
      continue;
    }

    const existing = result[existingIndex];
    const merged = shouldPreferInvoiceCopyCandidate(document, existing)
      ? mergeInvoiceCopyDocuments(document, existing)
      : mergeInvoiceCopyDocuments(existing, document);
    // The merge prevents double-counted totals, but the duplicate itself must
    // stay visible: record every distinct source file that collapsed here so
    // the application can raise a duplicate-invoice warning downstream.
    const sources = [
      ...new Set(
        [
          existing.sourceFileName,
          document.sourceFileName,
          ...(existing.collapsedDuplicateSources ?? []),
          ...(document.collapsedDuplicateSources ?? []),
        ]
          .filter((name): name is string => Boolean(name))
          .map((name) => name.trim())
          .filter(Boolean),
      ),
    ];
    result[existingIndex] =
      sources.length > 1 ? { ...merged, collapsedDuplicateSources: sources } : merged;
  }

  return result;
}

function countMeaningfulFields(fields: Partial<Record<FieldKey, string>>) {
  return Object.values(fields).filter(
    (value) => value !== undefined && value !== null && String(value).trim(),
  ).length;
}

function hasVisibleCommercialItemTable(doc: CaseDoc) {
  const visibleText = String(doc.md ?? "").toLowerCase();
  if (!visibleText) return false;
  const hasItemHeading =
    /\b(description|particulars?|item\s+description|invoice\s+items?)\b/.test(
      visibleText,
    );
  const hasQuantityHeading = /\b(qty|quantity)\b/.test(visibleText);
  const hasCommercialHeading = /\b(hsn|sac|rate|taxable|amount|value)\b/.test(
    visibleText,
  );
  return hasItemHeading && hasQuantityHeading && hasCommercialHeading;
}

function hasPositiveInvoiceValue(doc: CaseDoc) {
  return ["totalTaxableAmount", "subtotal", "totalAmount"].some((key) => {
    const value = parseLooseNumber(doc.fields?.[key as FieldKey]);
    return value !== null && value > 0;
  });
}

function hasIncompleteVisibleInvoiceLines(doc: CaseDoc) {
  return (
    (doc.type === "Tax Invoice" || doc.type === "Invoice") &&
    !doc.lineItems?.length &&
    hasPositiveInvoiceValue(doc) &&
    hasVisibleCommercialItemTable(doc)
  );
}

function hasLineItemArithmeticConflict(doc: CaseDoc) {
  if (!isCommercialDocType(doc.type) || !doc.lineItems?.length) return false;

  return doc.lineItems.some((item) => {
    const quantity = parseLooseNumber(item.quantity);
    const rate = parseLooseNumber(item.netRate ?? item.rate);
    const amount = parseLooseNumber(item.taxableAmount ?? item.lineTotal);
    if (
      quantity === null ||
      rate === null ||
      amount === null ||
      quantity <= 0 ||
      rate <= 0 ||
      amount <= 0
    ) {
      return false;
    }

    const discount = parseLooseNumber(item.discountPercent);
    const expected =
      quantity *
      rate *
      (item.netRate || discount === null ? 1 : Math.max(0, 1 - discount / 100));
    return !numbersClose(expected, amount, Math.max(1, amount * 0.005));
  });
}

function isWeakExtraction(doc: CaseDoc) {
  const fields = doc.fields ?? {};
  const meaningfulFieldCount = countMeaningfulFields(fields);
  const hasLineItems = Boolean(doc.lineItems?.length);
  const hasAnyField = (...keys: FieldKey[]) =>
    keys.some((key) => Boolean(fields[key]?.trim()));

  switch (doc.type) {
    case "Purchase Order":
    case "Amended Purchase Order":
      return (
        !hasAnyField(
          "poNumber",
          "totalAmount",
          "itemDescription",
          "itemQuantity",
        ) && !hasLineItems
      );
    case "PAN Card":
      return !fields.panNumber && !fields.holderName;
    case "Driving Licence":
      return !fields.licenseNumber && !fields.driverName;
    case "Vehicle Registration Certificate":
      return (
        !fields.registrationNumber && !fields.vehicleNumber && !fields.ownerName
      );
    case "FASTag Toll Proof":
      return (
        !fields.vehicleNumber &&
        !fields.fastagReference &&
        !fields.tollTransactionSummary
      );
    case "E-Way Bill":
      return !fields.eWayBillNumber && !fields.vehicleNumber;
    case "Tax Invoice":
    case "Invoice":
      return (
        hasIncompleteVisibleInvoiceLines(doc) ||
        (!hasAnyField(
          "invoiceNumber",
          "totalAmount",
          "itemDescription",
          "itemQuantity",
        ) &&
          !hasLineItems)
      );
    case "Receipt":
      return !hasAnyField(
        "receiptNumber",
        "referenceInvoiceNumber",
        "paidAmount",
        "transactionDate",
      );
    case "Delivery Challan":
    case "Delivery Note":
      return (
        !hasAnyField(
          "deliveryNoteNumber",
          "referencePoNumber",
          "itemDescription",
          "itemQuantity",
          "vehicleNumber",
        ) && !hasLineItems
      );
    case "Weighment Slip":
      return !fields.netWeight && !fields.grossWeight && !fields.vehicleNumber;
    case "Lorry Receipt":
      return !hasAnyField(
        "lorryReceiptNumber",
        "vehicleNumber",
        "netWeight",
        "routeFrom",
        "routeTo",
      );
    case "Material Test Certificate":
      return !hasAnyField(
        "certificateNumber",
        "batchNumber",
        "heatNumber",
        "itemQuantity",
        "grossWeight",
        "netWeight",
      );
    case "Transport Permit":
      return !hasAnyField(
        "permitNumber",
        "permitType",
        "vehicleNumber",
        "validityDate",
      );
    case "Bank Statement":
      return !hasAnyField(
        "bankName",
        "accountNumber",
        "transactionDate",
        "transactionReference",
        "statementAmount",
      );
    case "Map Printout":
      return !hasAnyField("routeFrom", "routeTo", "mapLocation");
    case "Payment Screenshot":
      return !hasAnyField(
        "transactionDate",
        "transactionReference",
        "paidAmount",
        "statementAmount",
      );
    default:
      return doc.type !== "Unknown" && meaningfulFieldCount === 0;
  }
}

function needsImageFallbackForTextExtraction(doc: CaseDoc) {
  if (isWeakExtraction(doc)) return true;

  const fields = doc.fields ?? {};
  const hasLineItems = Boolean(doc.lineItems?.length);
  const hasAnyField = (...keys: FieldKey[]) =>
    keys.some((key) => Boolean(fields[key]?.trim()));

  switch (doc.type) {
    case "Purchase Order":
    case "Amended Purchase Order":
      return !fields.poNumber || (!hasLineItems && !fields.itemDescription);
    case "Tax Invoice":
    case "Invoice":
      return (
        !fields.invoiceNumber || (!hasLineItems && !fields.itemDescription)
      );
    case "Receipt":
      return !hasAnyField("receiptNumber", "paidAmount");
    case "Delivery Challan":
    case "Delivery Note":
      return (
        !fields.deliveryNoteNumber || (!hasLineItems && !fields.itemQuantity)
      );
    case "E-Way Bill":
      return !fields.eWayBillNumber || !fields.vehicleNumber;
    case "Weighment Slip":
      return (
        !fields.vehicleNumber ||
        !hasAnyField("grossWeight", "tareWeight", "netWeight")
      );
    case "Lorry Receipt":
      return !fields.lorryReceiptNumber || !fields.vehicleNumber;
    case "Material Test Certificate":
      return (
        !fields.certificateNumber || !hasAnyField("batchNumber", "heatNumber")
      );
    case "Transport Permit":
      return !fields.permitNumber || !fields.vehicleNumber;
    case "Bank Statement":
      return !hasAnyField(
        "accountNumber",
        "transactionDate",
        "transactionReference",
        "statementAmount",
      );
    case "Payment Screenshot":
      return !hasAnyField(
        "transactionDate",
        "transactionReference",
        "paidAmount",
        "statementAmount",
      );
    default:
      return false;
  }
}

function normalizeFieldValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const text = String(value).trim();
    return text || undefined;
  }
  if (Array.isArray(value)) {
    const text = value
      .map((entry) => {
        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          const parts = [
            normalizeFieldValue(
              record.date ?? record.dateTime ?? record.transactionDate,
            ),
            normalizeFieldValue(
              record.plaza ?? record.tollPlaza ?? record.location,
            ),
            normalizeFieldValue(
              record.amount ?? record.debitAmount ?? record.paidAmount,
            ),
          ].filter(Boolean);
          return parts.length
            ? parts.join(" - ")
            : normalizeFieldValue(record.description ?? record.summary);
        }
        return normalizeFieldValue(entry);
      })
      .filter(Boolean)
      .join("\n");
    return text || undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const text = normalizeFieldValue(
      record.value ?? record.text ?? record.summary ?? record.description,
    );
    if (text) return text;
    const fallback = Object.entries(record)
      .map(([key, entry]) =>
        `${key}: ${normalizeFieldValue(entry) ?? ""}`.trim(),
      )
      .filter((entry) => !entry.endsWith(":"))
      .join(", ");
    return fallback || undefined;
  }
  const text = String(value).trim();
  return text || undefined;
}

function cleanEWayAddress(value?: string) {
  const cleaned = value
    ?.replace(/\s+/g, " ")
    .replace(
      /\b(Address\s+Details|Dispatch\s+From|Ship\s+To|GSTIN|State|Pin\s*Code)\b\s*:*/gi,
      " ",
    )
    .replace(/^[\s:;,\-.]+/, "")
    .replace(/[\s,.;:-]+$/, "")
    .trim();
  return cleaned || undefined;
}

const EWAY_PARTY_STOP_PATTERN =
  /\b(?:::?\s*)?(?:Dispatch\s+From|Dispatched\s+From|Ship\s+To|Ship-to|Goods\s+Details|Vehicle\s+Details|Part\s+B|Transporter\s+Details|Total\s+Invoice|Taxable\s+Amount|Recipient)\b/i;
const EWAY_PARTY_NAME_END_PATTERN =
  /\b(?:PRIVATE\s+LIMITED|PVT\.?\s*LTD\.?|LTD\.?|LIMITED|LLP|ENTERPRISES|INDUSTRIES|IMPEX|LOGISTICS|MARKETING|FABRICATORS|SYSTEMS|SOLUTIONS|TRADE\s+LINK|WIRES\s*&\s*INFRA\s+LIMITED)\b/i;
const INDIAN_STATE_SUFFIX_PATTERN =
  /\b(?:ANDHRA\s+PRADESH|ARUNACHAL\s+PRADESH|ASSAM|BIHAR|CHHATTISGARH|CHATTISGARH|GOA|GUJARAT|HARYANA|HIMACHAL\s+PRADESH|JHARKHAND|KARNATAKA|KERALA|MADHYA\s+PRADESH|MAHARASHTRA|MANIPUR|MEGHALAYA|MIZORAM|NAGALAND|ODISHA|ORISSA|PUNJAB|RAJASTHAN|SIKKIM|TAMIL\s+NADU|TELANGANA|TRIPURA|UTTAR\s+PRADESH|UTTARAKHAND|WEST\s+BENGAL|DELHI|CHANDIGARH|PUDUCHERRY|JAMMU\s+AND\s+KASHMIR|LADAKH|INDIA|MAH)\b\.?$/i;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingGstinToken(value: string, knownGstin?: string) {
  const compactKnownGstin = knownGstin?.replace(/[^a-z0-9]/gi, "");
  if (compactKnownGstin && compactKnownGstin.length >= 10) {
    const knownPattern = new RegExp(
      `^\\s*${compactKnownGstin.split("").map(escapeRegExp).join("\\s*")}\\s*`,
      "i",
    );
    const stripped = value.replace(knownPattern, "");
    if (stripped !== value) return stripped;
  }

  if (!/^\s*\d{2}/.test(value)) return value;

  let alnumCount = 0;
  let endIndex = -1;

  for (let index = 0; index < value.length; index += 1) {
    if (/[a-z0-9]/i.test(value[index])) {
      alnumCount += 1;
      if (alnumCount >= 15) {
        endIndex = index + 1;
        break;
      }
    }
  }

  return endIndex > 0 ? value.slice(endIndex) : value;
}

function cleanEWayPartyName(value?: string, knownGstin?: string) {
  if (!value) return undefined;
  const beforeStop = value.split(EWAY_PARTY_STOP_PATTERN)[0] ?? value;
  let cleaned = stripLeadingGstinToken(beforeStop, knownGstin)
    .replace(/\s+/g, " ")
    .replace(/\b(?:Address\s+Details|From|To|GSTIN|State|Portal)\b\s*:*/gi, " ")
    .replace(/^\W*\d+\s+/, "")
    .replace(/^[\s:;,\-.]+/, "")
    .replace(/[\s,.;:-]+$/, "")
    .trim();

  while (INDIAN_STATE_SUFFIX_PATTERN.test(cleaned)) {
    cleaned = cleaned
      .replace(INDIAN_STATE_SUFFIX_PATTERN, "")
      .replace(/[\s,.;:-]+$/, "")
      .trim();
  }

  if (
    /\b(?:ltd|limited|private|pvt|llp|industries|enterprises|logistics|alloys|steel|link|wires|solutions)\b/i.test(
      cleaned,
    )
  ) {
    cleaned = cleaned.replace(/,\s*[^,]+$/i, "").trim();
  }

  const legalPrefix = extractEWayLegalNamePrefix(cleaned);
  if (
    legalPrefix &&
    (cleaned.length > 90 ||
      /@|\b(?:building\s+no|flat\s+no|name\s+of\s+building|phone|plot\s+no|survey\s+no)\b/i.test(
        cleaned,
      ))
  ) {
    cleaned = legalPrefix;
  }

  if (!/[a-z]/i.test(cleaned)) return undefined;
  if (cleaned.length > 90) return undefined;
  if (/\*/.test(cleaned)) return undefined;
  if (
    /\b(?:recipient|consignor|building\s+no|flat\s+no|name\s+of\s+building|phone|survey\s+no|plot\s+no|moudha|phase\s+\d|@)\b/i.test(
      cleaned,
    )
  ) {
    return undefined;
  }

  return cleaned;
}

function extractEWayLegalNamePrefix(value: string) {
  const match = value.match(EWAY_PARTY_NAME_END_PATTERN);
  if (!match || match.index === undefined) return undefined;
  return value.slice(0, match.index + match[0].length).trim();
}

function splitEWayPartyPair(
  value?: string,
): Partial<Record<"vendorName" | "buyerName", string>> {
  const candidate = value
    ?.split(EWAY_PARTY_STOP_PATTERN)[0]
    ?.replace(/\s+/g, " ")
    .replace(/\b(?:Address\s+Details|From|To|GSTIN|State|Portal)\b\s*:*/gi, " ")
    .trim();
  if (!candidate) return {};

  const firstParty = extractEWayLegalNamePrefix(candidate);
  if (!firstParty) return {};
  const secondCandidate = candidate.slice(firstParty.length).trim();
  const secondParty =
    extractEWayLegalNamePrefix(secondCandidate) ?? secondCandidate;

  return {
    vendorName: cleanEWayPartyName(firstParty),
    buyerName: cleanEWayPartyName(secondParty),
  };
}

function extractEWayBillPartyNames(
  visibleText: string,
  fields: Partial<Record<FieldKey, string>>,
): Partial<Record<FieldKey, string>> {
  const text = visibleText.replace(/\s+/g, " ").trim();
  const section =
    text.match(
      /\bAddress\s+Details\b\s*(.+?)(?=\b(?:Vehicle\s+Details|Part\s+B|Transporter\s+Details|Total\s+Invoice|Taxable\s+Amount)\b|$)/i,
    )?.[1] ?? text;
  const namesBeforeGstin = section.match(
    /\bFrom\s+To\s+(.+?)\bGSTIN\s*:?\s*/i,
  )?.[1];
  const preGstinPair = splitEWayPartyPair(namesBeforeGstin);
  const gstinBlocks = section.split(/\bGSTIN\s*:?\s*/i).slice(1);
  const postGstinText = stripLeadingGstinToken(
    gstinBlocks[1] ?? "",
    fields.buyerGstin,
  );
  const postGstinPair = splitEWayPartyPair(postGstinText);

  return {
    vendorName:
      cleanEWayPartyName(gstinBlocks[0], fields.supplierGstin) ??
      preGstinPair.vendorName ??
      (postGstinPair.buyerName ? postGstinPair.vendorName : undefined),
    buyerName:
      preGstinPair.buyerName ??
      postGstinPair.buyerName ??
      cleanEWayPartyName(gstinBlocks[1], fields.buyerGstin) ??
      postGstinPair.vendorName ??
      cleanEWayPartyName(postGstinText),
  };
}

function extractEWayBillAddresses(
  visibleText: string,
): Partial<Record<FieldKey, string>> {
  const text = visibleText.replace(/\s+/g, " ").trim();
  const match = text.match(
    /(?:Address\s+Details\s*)?(?:[:：]\s*)?(?:Dispatch\s+From|Dispatched\s+From)\s*[:：]?\s*(.+?)\s*(?:Ship\s+To|Ship-to)\s*[:：]?\s*(.+?)(?=\s*(?:Vehicle\s+Details|Part\s+B|Item\s+Details|Total|$))/i,
  );
  if (!match) return {};
  return {
    dispatchFrom: cleanEWayAddress(match[1]),
    shipTo: cleanEWayAddress(match[2]),
  };
}

function normalizeEWayReferenceText(value: string) {
  const withoutDocumentType = value
    .replace(
      /^\s*(?:tax\s*invoice|invoice|delivery\s*challan|document|doc(?:ument)?\s*no\.?)\s*[-:/]?\s*/i,
      "",
    )
    .replace(
      /^\s*(?:taxinvoice|deliverychallan|invoice|document|docno)\s*[-:/]?\s*/i,
      "",
    );
  const normalized = withoutDocumentType
    .replace(/[ΚK]\s*[ΑA]/g, "KA")
    .replace(/[ΟO]/g, "O")
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9/-]/gi, "")
    .toUpperCase();
  const withoutTrailingDate = normalized.replace(
    /-\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/,
    "",
  );
  return /[A-Z]/.test(withoutTrailingDate) && withoutTrailingDate.length >= 5
    ? withoutTrailingDate
    : normalized;
}

function extractEWayBillReferenceInvoiceNumber(visibleText: string) {
  const text = visibleText.replace(/\s+/g, " ").trim();
  const documentDetails = text.match(
    /\bDocument\s+Details\s*:?\s*([\s\S]{0,220}?)(?=\s+\b(?:IRN|RN|Address\s+Details|GSTIN|Goods\s+Details)\b|$)/i,
  )?.[1];
  if (!documentDetails) return undefined;

  const seriesPrefix = normalizeEWayReferenceText(
    documentDetails.match(
      /\b(?:Tax\s+Invoice|Invoice|Delivery\s+Challan)\s*[-:'"]+\s*([A-ZΑ-Ω]{1,8})(?=\s+(?:Transaction\s*type|Portal|Regular|\d)|\s*[-/]?\s*\d)/i,
    )?.[1] ?? "",
  );
  const cleanedDetails = documentDetails
    .replace(/\bTransaction\s*type\s*[:;]?\s*[A-Z]+\b/gi, " ")
    .replace(/\bPortal\s*:?\s*\d+\b/gi, " ")
    .replace(/\b(?:Tax\s+Invoice|Invoice|Delivery\s+Challan)\b/gi, " ");
  const candidates = [
    ...cleanedDetails.matchAll(
      /\b(?:[A-ZΑ-Ω]{1,8}\s*[-/]?\s*)?\d{2,}[A-ZΑ-Ω0-9]*(?:[/-]\d{1,4}){0,5}\b/gi,
    ),
  ]
    .map((match) => normalizeEWayReferenceText(match[0]))
    .filter((candidate) => isEWayReferenceCandidate(candidate));
  const withSeries = candidates.find((candidate) => /[A-ZΑ-Ω]/.test(candidate));
  const numericOnly = candidates.find(
    (candidate) => !/[A-ZΑ-Ω]/.test(candidate),
  );

  if (seriesPrefix && numericOnly) return `${seriesPrefix}-${numericOnly}`;
  return withSeries ? formatEWaySeriesReference(withSeries) : numericOnly;
}

function cleanExistingEWayReferenceInvoiceNumber(value?: string) {
  if (!value) return undefined;
  const normalized = normalizeEWayReferenceText(value);
  return normalized.length >= 2 && /\d/.test(normalized)
    ? normalized
    : undefined;
}

function formatEWaySeriesReference(value: string) {
  return value.replace(/^([A-ZΑ-Ω]{1,12})[-/]?(\d)/, "$1-$2");
}

function isEWayReferenceCandidate(value: string) {
  const compact = value.replace(/[^A-Z0-9Α-Ω]/gi, "");
  if (compact.length < 4 || !/\d/.test(compact)) return false;
  return !/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/i.test(value);
}

function compactEWayReference(value?: string) {
  return value?.replace(/[^A-Z0-9Α-Ω]/gi, "").toUpperCase() ?? "";
}

function stripEWayReferenceSeries(value: string) {
  return value.replace(/^[A-ZΑ-Ω]{1,12}(?=\d)/, "");
}

function chooseEWayReferenceInvoiceNumber(
  existing?: string,
  extracted?: string,
) {
  const cleanedExisting = cleanExistingEWayReferenceInvoiceNumber(existing);
  const cleanedExtracted = cleanExistingEWayReferenceInvoiceNumber(extracted);
  if (!cleanedExisting) return cleanedExtracted;
  if (!cleanedExtracted) return cleanedExisting;

  const existingCompact = compactEWayReference(cleanedExisting);
  const extractedCompact = compactEWayReference(cleanedExtracted);
  if (existingCompact === extractedCompact) return cleanedExisting;

  const existingHasSeries = /^[A-ZΑ-Ω]{1,12}\d{6,}$/.test(existingCompact);
  const extractedHasSeries = /^[A-ZΑ-Ω]{1,12}\d{6,}$/.test(extractedCompact);
  const existingBody = stripEWayReferenceSeries(existingCompact);
  const extractedBody = stripEWayReferenceSeries(extractedCompact);

  if (
    extractedHasSeries &&
    !existingHasSeries &&
    extractedBody === existingCompact
  ) {
    return cleanedExtracted;
  }
  if (
    existingHasSeries &&
    !extractedHasSeries &&
    existingBody === extractedCompact
  ) {
    return cleanedExisting;
  }

  return cleanedExisting;
}

const EWAY_DATE_PATTERN =
  "(?:\\d{4}[/-]\\d{1,2}[/-]\\d{1,2}|\\d{1,2}[/. -]\\d{1,2}[/. -]\\d{2,4}|\\d{1,2}-[A-Za-z]{3}-\\d{2,4})(?:\\s+\\d{1,2}:\\d{2}(?::\\d{2})?\\s*(?:AM|PM)?)?";
const EWAY_VEHICLE_PATTERN = /\b[A-Z]{2}\s*\d{1,2}\s*[A-Z]{1,3}\s*\d{3,4}\b/gi;
const EWAY_GSTIN_PATTERN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/gi;

function cleanEWayDateValue(value?: string) {
  const raw = value?.match(new RegExp(EWAY_DATE_PATTERN, "i"))?.[0];
  return raw
    ?.replace(/\s*([/-])\s*/g, "$1")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

function extractEWayDate(text: string, labelPattern: string) {
  const direct = text.match(
    new RegExp(`\\b${labelPattern}\\s*:?\\s*(${EWAY_DATE_PATTERN})`, "i"),
  )?.[1];
  if (direct) return cleanEWayDateValue(direct);

  const context = text.match(
    new RegExp(`\\b${labelPattern}\\b([\\s\\S]{0,140})`, "i"),
  )?.[1];
  return cleanEWayDateValue(context);
}

function normalizeEWayAmount(value?: string) {
  if (!value) return null;
  let compact = value.replace(/[₹$€£\s]/g, "");
  if (/^-?\d+,\d{2}$/.test(compact) && !compact.includes(".")) {
    compact = compact.replace(/,(\d{2})$/, ".$1");
  }
  compact = compact.replace(/,/g, "");
  const parsed = Number(compact);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatEWayNumberForField(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2).replace(/\.?0+$/, "");
}

function extractEWayAmounts(value: string) {
  return [
    ...value.matchAll(
      /-?\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|-?\d+,\d{2}\b|-?\d+\.\d{1,2}\b/g,
    ),
  ]
    .map((match) => normalizeEWayAmount(match[0]))
    .filter((amount): amount is number => amount !== null);
}

function extractEWayCommercialAmounts(
  text: string,
  fields: Partial<Record<FieldKey, string>>,
) {
  const summaryBlock =
    text.match(
      /\b(?:Tot\.?\s*Tax'?ble\s*Amt|Total\s+Taxable\s+Amt)\b[\s\S]{0,700}?(?=\b(?:Transportation\s+Details|Transporter\s+ID|Vehicle\s+Details|Part\s*-?\s*B)\b|$)/i,
    )?.[0] ??
    text.match(
      /\b(?:Taxable\s+Amount|Taxable\s+Value)\b[\s\S]{0,700}?(?=\b(?:Transportation\s+Details|Transporter\s+ID|Vehicle\s+Details|Part\s*-?\s*B)\b|$)/i,
    )?.[0];
  const amounts = summaryBlock ? extractEWayAmounts(summaryBlock) : [];
  const existingSubtotal = normalizeEWayAmount(fields.subtotal);
  const existingTax = normalizeEWayAmount(fields.taxAmount);
  const existingTotal = normalizeEWayAmount(fields.totalAmount);
  const subtotal = existingSubtotal ?? amounts[0] ?? null;
  const blockTotal = amounts.length >= 2 ? amounts[amounts.length - 1] : null;
  const total =
    existingTotal ??
    (blockTotal !== null && subtotal !== null && blockTotal >= subtotal
      ? blockTotal
      : null);
  const taxAmount =
    existingTax ??
    (subtotal !== null && total !== null && total >= subtotal
      ? Math.round((total - subtotal) * 100) / 100
      : null);
  const derivedSubtotal =
    subtotal ??
    (total !== null && taxAmount !== null && total >= taxAmount
      ? Math.round((total - taxAmount) * 100) / 100
      : null);
  const taxRate =
    derivedSubtotal !== null && derivedSubtotal > 0 && taxAmount !== null
      ? Math.round((taxAmount / derivedSubtotal) * 10000) / 100
      : null;

  return {
    subtotal:
      derivedSubtotal === null
        ? undefined
        : formatEWayNumberForField(derivedSubtotal),
    totalTaxableAmount:
      derivedSubtotal === null
        ? undefined
        : formatEWayNumberForField(derivedSubtotal),
    taxAmount:
      taxAmount === null ? undefined : formatEWayNumberForField(taxAmount),
    taxRate:
      taxRate === null || taxRate < 0 || taxRate > 40
        ? undefined
        : formatEWayNumberForField(taxRate),
    totalAmount: total === null ? undefined : formatEWayNumberForField(total),
  } satisfies Partial<Record<FieldKey, string>>;
}

function applyEWayValueOfGoodsGuard(
  fields: Partial<Record<FieldKey, string>>,
  visibleText: string,
) {
  const valueOfGoods = normalizeEWayAmount(
    visibleText.match(
      /\bValue\s+of\s+Goods\b\s*[:&|.=-]*\s*(?:Rs\.?|INR|₹)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i,
    )?.[1],
  );
  if (valueOfGoods === null) return fields;

  const hasExplicitTaxableAmount =
    /\b(?:Tot\.?\s*Tax'?ble\s*Amt|Total\s+Taxable\s+(?:Amt|Amount)|Taxable\s+(?:Amount|Value))\b/i.test(
      visibleText,
    );
  const hasExplicitInvoiceTotal =
    /\b(?:Total\s+Inv\.?\s*Amt|Total\s+Invoice\s+(?:Amt|Amount|Value)|Invoice\s+Total)\b/i.test(
      visibleText,
    );
  const next = { ...fields };
  const formattedValue = formatEWayNumberForField(valueOfGoods);

  if (!hasExplicitInvoiceTotal && !next.totalAmount) {
    next.totalAmount = formattedValue;
  }

  if (!hasExplicitTaxableAmount) {
    if (normalizeEWayAmount(next.subtotal) === valueOfGoods) {
      delete next.subtotal;
    }
    if (normalizeEWayAmount(next.totalTaxableAmount) === valueOfGoods) {
      delete next.totalTaxableAmount;
    }
  }

  return next;
}

function cleanEWayTransporterName(value?: string) {
  const cleaned = value
    ?.replace(
      /^\s*(?:\d{2}\s*[A-Z]{5}\s*\d{4}\s*[A-Z]\s*[0-9A-Z]\s*Z\s*[0-9A-Z]|[0-9A-Z\s]{10,20})\s*&\s*/i,
      "",
    )
    .replace(EWAY_GSTIN_PATTERN, "")
    .replace(/^[\s&:;,\-.]+/, "")
    .replace(
      /\b(?:Transporter\s+Doc|Vehicle\s+Details|Part\s*-?\s*B|Vehicle\s*\/\s*Trans|Mode\s+From|Entered\s+Date)\b[\s\S]*$/i,
      "",
    )
    .replace(/\s+/g, " ")
    .replace(/[\s,.;:-]+$/, "")
    .trim();
  if (!cleaned || !/[a-z]/i.test(cleaned) || cleaned.length > 90)
    return undefined;
  return cleaned;
}

function formatEWayVehicleNumber(value?: string) {
  const compact = value?.replace(/\s+/g, "").toUpperCase();
  return compact && /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{3,4}$/.test(compact)
    ? compact
    : undefined;
}

function extractEWayVehicleNumber(text: string) {
  const vehicleBlock =
    text.match(
      /\b(?:Vehicle\s+Details|Part\s*-?\s*B)\b([\s\S]{0,900})/i,
    )?.[1] ?? text;
  const roadVehicle = formatEWayVehicleNumber(
    vehicleBlock.match(
      new RegExp(`\\bRoad\\s+(${EWAY_VEHICLE_PATTERN.source})`, "i"),
    )?.[1],
  );
  if (roadVehicle) return roadVehicle;

  return [...vehicleBlock.matchAll(EWAY_VEHICLE_PATTERN)]
    .map((match) => formatEWayVehicleNumber(match[0]))
    .find((value): value is string => Boolean(value));
}

function extractEWayTransporterDocFromVehicleRow(
  text: string,
  vehicleNumber?: string,
) {
  if (!vehicleNumber) return undefined;
  const vehicleWithSpaces = vehicleNumber.replace(
    /([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{3,4})/,
    "$1\\s*$2\\s*$3\\s*$4",
  );
  const rowDoc = text.match(
    new RegExp(
      `\\bRoad\\s+${vehicleWithSpaces}\\s*&\\s*([A-Z0-9/-]{2,})\\s*&\\s*${EWAY_DATE_PATTERN}`,
      "i",
    ),
  )?.[1];
  return rowDoc && rowDoc !== "0" ? rowDoc.trim() : undefined;
}

function extractEWayTransportDetails(text: string) {
  const transporterName = cleanEWayTransporterName(
    text.match(
      /\bTransporter\s+ID\s*&\s*Name\s*:?\s*(?:[0-9A-Z\s]{10,20}\s*&\s*)?(.+?)(?=\s*(?:\d+\s*[.)]?\s*)?(?:Transporter\s+Doc|Vehicle\s+Details|Part\s*-?\s*B|$))/i,
    )?.[1],
  );
  const vehicleNumber = extractEWayVehicleNumber(text);
  const transporterDoc =
    text
      .match(
        /\bTransporter\s+Doc\.?\s*(?:No\.?|Number)?\s*&\s*Date\s*:?\s*([A-Z0-9/-]+)(?=\s*&|\s+\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\s|$)/i,
      )?.[1]
      ?.trim() ?? extractEWayTransporterDocFromVehicleRow(text, vehicleNumber);

  return {
    transporterName,
    lorryReceiptNumber:
      transporterDoc && transporterDoc !== "0" ? transporterDoc : undefined,
    vehicleNumber,
  } satisfies Partial<Record<FieldKey, string>>;
}

function applyEWayBillAddressFallback(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType,
  visibleText: string,
) {
  if (docType !== "E-Way Bill" || !visibleText.trim()) return fields;
  const text = visibleText.replace(/\s+/g, " ").trim();
  const addresses = extractEWayBillAddresses(visibleText);
  const parties = extractEWayBillPartyNames(visibleText, fields);
  const referenceInvoiceNumber = chooseEWayReferenceInvoiceNumber(
    fields.referenceInvoiceNumber,
    extractEWayBillReferenceInvoiceNumber(visibleText),
  );
  const amounts = extractEWayCommercialAmounts(text, fields);
  const transport = extractEWayTransportDetails(text);
  const transporterName =
    transport.transporterName ??
    cleanEWayTransporterName(fields.transporterName);
  const vehicleNumber =
    formatEWayVehicleNumber(fields.vehicleNumber) ?? transport.vehicleNumber;
  const documentDate = extractEWayDate(
    text,
    "(?:Generated\\s+Date|E-?Way\\s+Bill\\s+Date|Way\\s+Bill\\s+Date)",
  );
  const validityDate =
    extractEWayDate(text, "(?:Valid\\s*(?:Upto|Up\\s*To|Until|Till))") ??
    cleanEWayDateValue(fields.validityDate);
  const enrichedFields = {
    ...fields,
    ...(fields.vendorName || !parties.vendorName
      ? {}
      : { vendorName: parties.vendorName }),
    ...(fields.buyerName || !parties.buyerName
      ? {}
      : { buyerName: parties.buyerName }),
    ...(!referenceInvoiceNumber ||
    referenceInvoiceNumber === fields.referenceInvoiceNumber
      ? {}
      : { referenceInvoiceNumber }),
    ...(fields.documentDate || !documentDate ? {} : { documentDate }),
    ...(!validityDate || validityDate === fields.validityDate
      ? {}
      : { validityDate }),
    ...(fields.subtotal || !amounts.subtotal
      ? {}
      : { subtotal: amounts.subtotal }),
    ...(fields.totalTaxableAmount ||
    !(amounts.totalTaxableAmount ?? amounts.subtotal)
      ? {}
      : { totalTaxableAmount: amounts.totalTaxableAmount ?? amounts.subtotal }),
    ...(fields.taxAmount || !amounts.taxAmount
      ? {}
      : { taxAmount: amounts.taxAmount }),
    ...(fields.taxRate || !amounts.taxRate ? {} : { taxRate: amounts.taxRate }),
    ...(fields.totalAmount || !amounts.totalAmount
      ? {}
      : { totalAmount: amounts.totalAmount }),
    ...(!transporterName ? {} : { transporterName }),
    ...(fields.lorryReceiptNumber || !transport.lorryReceiptNumber
      ? {}
      : { lorryReceiptNumber: transport.lorryReceiptNumber }),
    ...(!vehicleNumber || vehicleNumber === fields.vehicleNumber
      ? {}
      : { vehicleNumber }),
    ...(fields.dispatchFrom || !addresses.dispatchFrom
      ? {}
      : { dispatchFrom: addresses.dispatchFrom }),
    ...(fields.shipTo || !addresses.shipTo ? {} : { shipTo: addresses.shipTo }),
  };
  return applyEWayValueOfGoodsGuard(enrichedFields, text);
}

function extractFirstMatch(text: string, pattern: RegExp) {
  const match = text.match(pattern);
  return match?.[1]?.replace(/\s+/g, " ").trim();
}

function extractFastagTransactions(visibleText: string) {
  const lines = visibleText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const entries: Array<{
    dateTime: string;
    plaza: string;
    lane?: string;
    amount: string;
  }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const dateTime = lines[index].match(
      /\d{2}[-/]\d{2}[-/]\d{4}\s+\d{2}:\d{2}:\d{2}/,
    )?.[0];
    if (!dateTime) continue;

    const block: string[] = [lines[index]];
    for (let next = index + 1; next < lines.length; next += 1) {
      if (/\d{2}[-/]\d{2}[-/]\d{4}\s+\d{2}:\d{2}:\d{2}/.test(lines[next]))
        break;
      block.push(lines[next]);
    }

    const blockText = block.join(" ");
    if (!/Plaza\s+Name/i.test(blockText)) continue;

    const plaza = blockText
      .match(
        /Plaza\s+Name\s*:?\s*([A-Za-z][A-Za-z0-9 ()]+?)(?=\s*-\s*Lane|\s+Lane\s+ID|\s+0\.00|\s+\/?\d{8,}|$)/i,
      )?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
    if (!plaza) continue;

    const lane = blockText
      .match(
        /Lane\s+ID\s*:?\s*([A-Z0-9 ]+?)(?=\s+0\.00|\s+\d{1,3}(?:,\d{3})*(?:\.\d{2})|$)/i,
      )?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
    const amounts = [
      ...blockText.matchAll(/\b\d{1,3}(?:,\d{3})*(?:\.\d{2})\b/g),
    ].map((match) => match[0]);
    const amount = amounts.at(-1);
    if (!amount) continue;

    entries.push({ dateTime, plaza, lane, amount });
  }

  return entries;
}

function extractFastagDetails(
  visibleText: string,
): Partial<Record<FieldKey, string>> {
  const compact = visibleText.replace(/\s+/g, " ").trim();
  if (!compact) return {};

  const summaryMatch = compact.match(
    /(\d{6,})\s+([A-Z]{2}\d{2}[A-Z]{1,3}\d{4})\s+\S+\s+(\d+)\s+([\d,.]+)\s+([\d,.]+)\s+-?\s*([\d,.]+)\s+([\d,.]+)/i,
  );
  const tagVehicleBlock = compact.match(
    /Tag\s+Account\s+No\.\s+Licence\s+Plate\s+No\..*?(\d{6,})\s+([A-Z]{2}\d{2}[A-Z]{1,3}\d{4})/i,
  );
  const vehicleTagMatch = compact.match(
    /\b([A-Z]{2}\d{2}[A-Z0-9]{1,4}\d{3,4})\s*[-–]\s*(\d{6,})\b/i,
  );
  const paymentMatch = compact.match(/\bPayment\b.*?([\d,]+\.\d{2})\s+0\.00/i);
  const transactionRows = extractFastagTransactions(visibleText);
  const transactionSummary = transactionRows
    .slice(0, 12)
    .map((entry) => {
      const lane = entry.lane ? ` Lane ID:${entry.lane}` : "";
      return `${entry.dateTime} Plaza Name: ${entry.plaza}${lane} Amount (DR) ${entry.amount}`;
    })
    .join("\n");
  const statementDate = extractFirstMatch(
    compact,
    /Statement\s+Date\s*:?\s*(\d{2}[-/]\d{2}[-/]\d{4})/i,
  );
  const statementReference = (
    extractFirstMatch(
      compact,
      /Statement\s+Reference\s+Number\s+([A-Z0-9/.-]+)/i,
    ) ??
    extractFirstMatch(
      compact,
      /Statement\s+Reference\s+(?:Number\s+)?([A-Z0-9/.-]+)/i,
    )
  )?.replace(/t/gi, "/");
  const customerId = extractFirstMatch(
    compact,
    /Customer\s+[Il1]?D\s*:?\s*(?:[A-Z0-9/.-]+\s+)?(\d{7,})/i,
  );
  const customerName =
    [
      ...compact.matchAll(
        /Name\s*:\s*([A-Z][A-Z .'-]+?)(?=\s+(?:Branch|Statement\s+Period|Bill\s+From|GSTIN|Address:|supply:))/gi,
      ),
    ]
      .map((match) => match[1].replace(/\s+/g, " ").trim())
      .find((name) => !/ICICI|BANK|BRANCH/i.test(name)) ??
    extractFirstMatch(
      compact,
      /Address\s*:\s*([A-Z][A-Z .'-]+?)\s+\d{1,5}[,\s]/i,
    );

  return {
    fastagStatementReference: statementReference,
    fastagCustomerId: customerId,
    fastagCustomerName: customerName,
    statementPeriod: extractFirstMatch(
      compact,
      /Statement\s+Period\s*:?\s*(\d{2}[-/]\d{2}[-/]\d{4}\s+to\s+\d{2}[-/]\d{2}[-/]\d{4})/i,
    ),
    statementDate,
    transactionDate: statementDate,
    ...(summaryMatch
      ? {
          fastagReference: summaryMatch[1],
          vehicleNumber: summaryMatch[2],
          tripCount: summaryMatch[3],
          openingBalance: summaryMatch[4],
          creditAmount: summaryMatch[5],
          debitAmount: summaryMatch[6].replace(/^-/, ""),
          closingBalance: summaryMatch[7],
          statementAmount: summaryMatch[7],
        }
      : {}),
    ...(!summaryMatch && tagVehicleBlock
      ? {
          fastagReference: tagVehicleBlock[1],
          vehicleNumber: tagVehicleBlock[2],
        }
      : {}),
    ...(!summaryMatch && !tagVehicleBlock && vehicleTagMatch
      ? {
          vehicleNumber: vehicleTagMatch[1],
          fastagReference: vehicleTagMatch[2],
        }
      : {}),
    ...(paymentMatch?.[1] ? { paidAmount: paymentMatch[1] } : {}),
    ...(transactionRows[0]?.plaza
      ? { tollPlaza: transactionRows[0].plaza }
      : {}),
    ...(transactionSummary
      ? { tollTransactionSummary: transactionSummary }
      : {}),
  };
}

function applyFastagDetailsFallback(
  fields: Partial<Record<FieldKey, string>>,
  docType: DocType,
  visibleText: string,
) {
  if (docType !== "FASTag Toll Proof" || !visibleText.trim()) return fields;
  const details = extractFastagDetails(visibleText);
  return Object.entries(details).reduce(
    (acc, [key, value]) => {
      if (value) acc[key as FieldKey] = value;
      return acc;
    },
    { ...fields } as Partial<Record<FieldKey, string>>,
  );
}

const FASTAG_CONTEXT_FIELDS: FieldKey[] = [
  "vehicleNumber",
  "fastagReference",
  "fastagStatementReference",
  "fastagCustomerId",
  "fastagCustomerName",
  "statementPeriod",
  "statementDate",
];

const PARTY_CONTEXT_DOC_TYPES = new Set<DocType>([
  "Purchase Order",
  "Amended Purchase Order",
  "Invoice",
  "Tax Invoice",
]);

const COMMERCIAL_TOTAL_DOC_TYPES = new Set<DocType>([
  "Purchase Order",
  "Amended Purchase Order",
  "Invoice",
  "Tax Invoice",
]);

const WEIGHT_MISMATCH_FIELDS = new Set<FieldKey>([
  "grossWeight",
  "tareWeight",
  "netWeight",
]);
const VEHICLE_CONSENSUS_DOC_TYPE_WEIGHT: Partial<Record<DocType, number>> = {
  "E-Way Bill": 4,
  "Tax Invoice": 3,
  Invoice: 3,
  "Delivery Challan": 3,
  "Delivery Note": 3,
  "Lorry Receipt": 3,
  "Vehicle Registration Certificate": 2,
  "Transport Permit": 2,
  "Photo Evidence": 1,
};
const VEHICLE_OCR_CORRECTABLE_DOC_TYPES = new Set<DocType>([
  "Delivery Challan",
  "Delivery Note",
  "Lorry Receipt",
  "Weighment Slip",
  "Transport Permit",
  "Photo Evidence",
]);

function normalizePacketValue(
  value: string | number | null | undefined,
  field?: FieldKey,
) {
  return (
    normalizeComparableValue(value, DEFAULT_COMPARISON_OPTIONS, field) || null
  );
}

function getSinglePacketValue(documents: CaseDoc[], field: FieldKey) {
  const values = [
    ...new Set(
      documents
        .map((doc) => normalizePacketValue(doc.fields[field], field))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  return values.length === 1
    ? documents.find(
        (doc) => normalizePacketValue(doc.fields[field], field) === values[0],
      )?.fields[field]
    : undefined;
}

function hasOnlyTransactionSummary(fields: Partial<Record<FieldKey, string>>) {
  const identityFields: FieldKey[] = [
    "vehicleNumber",
    "fastagReference",
    "fastagStatementReference",
    "fastagCustomerId",
    "fastagCustomerName",
    "statementPeriod",
    "statementDate",
  ];

  return Boolean(
    fields.tollTransactionSummary &&
    identityFields.every((field) => !fields[field]),
  );
}

function findBestFastagContext(documents: CaseDoc[]) {
  const fastagDocs = documents.filter(
    (doc) => doc.type === "FASTag Toll Proof",
  );
  return fastagDocs
    .filter((doc) => FASTAG_CONTEXT_FIELDS.some((field) => doc.fields[field]))
    .sort((left, right) => {
      const leftScore = FASTAG_CONTEXT_FIELDS.filter(
        (field) => left.fields[field],
      ).length;
      const rightScore = FASTAG_CONTEXT_FIELDS.filter(
        (field) => right.fields[field],
      ).length;
      return rightScore - leftScore;
    })[0];
}

function enrichFastagContinuationDocs(documents: CaseDoc[]) {
  const bestFastag = findBestFastagContext(documents);
  const packetVehicleNumber =
    bestFastag?.fields.vehicleNumber ??
    getSinglePacketValue(documents, "vehicleNumber");

  return documents.map((doc) => {
    if (doc.type !== "FASTag Toll Proof") return doc;
    if (
      !hasOnlyTransactionSummary(doc.fields) &&
      !FASTAG_CONTEXT_FIELDS.some(
        (field) => !doc.fields[field] && bestFastag?.fields[field],
      )
    ) {
      return doc;
    }

    const fields = { ...doc.fields };
    for (const field of FASTAG_CONTEXT_FIELDS) {
      const sourceValue =
        bestFastag?.id !== doc.id ? bestFastag?.fields[field] : undefined;
      if (!fields[field] && sourceValue) {
        fields[field] = sourceValue;
      }
    }
    if (!fields.vehicleNumber && packetVehicleNumber) {
      fields.vehicleNumber = packetVehicleNumber;
    }

    return { ...doc, fields };
  });
}

function getBestPartyNameByGstin(
  documents: CaseDoc[],
  gstinField: "supplierGstin" | "buyerGstin",
  nameField: "vendorName" | "buyerName",
  gstin: string | undefined,
) {
  const normalizedGstin = normalizePacketValue(gstin, gstinField);
  if (!normalizedGstin) return undefined;

  const candidates = documents
    .filter((doc) => PARTY_CONTEXT_DOC_TYPES.has(doc.type))
    .filter(
      (doc) =>
        normalizePacketValue(doc.fields[gstinField], gstinField) ===
        normalizedGstin,
    )
    .map((doc) => doc.fields[nameField])
    .filter((name): name is string => Boolean(name && /[a-z]/i.test(name)))
    .filter(
      (name) =>
        !/\b(?:pcr|portal|address|dispatch|ship|recipient)\b/i.test(name),
    );

  return candidates.sort((left, right) => right.length - left.length)[0];
}

function enrichEWayBillParties(documents: CaseDoc[]) {
  return documents.map((doc) => {
    if (doc.type !== "E-Way Bill") return doc;

    const vendorName = getBestPartyNameByGstin(
      documents,
      "supplierGstin",
      "vendorName",
      doc.fields.supplierGstin,
    );
    const buyerName = getBestPartyNameByGstin(
      documents,
      "buyerGstin",
      "buyerName",
      doc.fields.buyerGstin,
    );
    const fields = { ...doc.fields };

    if (vendorName && vendorName !== fields.vendorName) {
      fields.vendorName = vendorName;
    }
    if (buyerName && buyerName !== fields.buyerName) {
      fields.buyerName = buyerName;
    }

    return fields.vendorName === doc.fields.vendorName &&
      fields.buyerName === doc.fields.buyerName
      ? doc
      : { ...doc, fields };
  });
}

function areFieldRecordsEqual(
  left: Partial<Record<FieldKey, string>>,
  right: Partial<Record<FieldKey, string>>,
) {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(
    (key) => left[key as FieldKey] === right[key as FieldKey],
  );
}

function enrichEWayBillCoreFields(documents: CaseDoc[]) {
  return documents.map((doc) => {
    if (doc.type !== "E-Way Bill" || !doc.md?.trim()) return doc;

    const fields = applyEWayBillAddressFallback(doc.fields, doc.type, doc.md);
    return areFieldRecordsEqual(doc.fields, fields) ? doc : { ...doc, fields };
  });
}

function extractVisibleLorryInvoiceReference(markdown: string | undefined) {
  const visibleText = getVisibleTextFromMarkdown(markdown);
  const value = visibleText.match(
    /\b(?:GST\s+Inv(?:oice)?\.?|Tax\s+Invoice|Invoice)\s*(?:No\.?|Number)\s*[:#|.=-]*\s*([A-Z0-9][A-Z0-9/-]{2,})/i,
  )?.[1];
  return value?.replace(/[.,;]+$/, "").trim();
}

function extractVisibleLorryInvoiceValue(markdown: string | undefined) {
  const visibleText = getVisibleTextFromMarkdown(markdown);
  const value = visibleText.match(
    /\b(?:GST\s+Inv(?:oice)?\.?|Invoice)\s*Value\s*[:#|.=-]*\s*(?:Rs\.?|INR|₹)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i,
  )?.[1];
  return value?.replace(/,/g, "");
}

function normalizeLorryReferenceForDisplay(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9/-]/g, "");
}

function isStandaloneLorryReferenceLine(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  return Boolean(
    trimmed &&
    trimmed.length <= 32 &&
    /^[A-Z0-9][A-Z0-9 ./-]*$/i.test(trimmed) &&
    !/^(?:date|invoice|vehicle|loading|from|to|consignor|consignee)\b/i.test(
      trimmed,
    ),
  );
}

function extractVisibleLorryReceiptReference(markdown: string | undefined) {
  const visibleText = getVisibleTextFromMarkdown(markdown);
  const directValue = visibleText.match(
    /\b(?:L\.?\s*R\.?|G\.?\s*C\.?\s*Note|Consignment\s+Note)\s*(?:No\.?|Number)\s*[:#|.=-]*\s*([A-Z0-9][A-Z0-9/-]{2,})(?=\s|$)/i,
  )?.[1];
  const directCandidate = directValue
    ? normalizeLorryReferenceForDisplay(directValue)
    : "";
  if (
    directCandidate.length >= 4 &&
    directCandidate.length <= 30 &&
    /\d/.test(directCandidate)
  ) {
    return directCandidate;
  }

  const lines = visibleText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const labelPattern =
    /\b(?:L\.?\s*R\.?|G\.?\s*C\.?\s*Note|Consignment\s+Note)\s*(?:No\.?|Number)\b/i;

  for (let index = 0; index < lines.length; index += 1) {
    const match = labelPattern.exec(lines[index]);
    if (!match) continue;

    const inlineValue = lines[index]
      .slice((match.index ?? 0) + match[0].length)
      .replace(/\b(?:date|dated)\b[\s\S]*$/i, "")
      .replace(/^[\s:#|.=-]+/, "")
      .trim();
    const pieces = isStandaloneLorryReferenceLine(inlineValue)
      ? [inlineValue]
      : [];
    const nextLine = lines[index + 1];
    if (isStandaloneLorryReferenceLine(nextLine)) pieces.push(nextLine);

    const candidate = normalizeLorryReferenceForDisplay(pieces.join(""));
    if (
      candidate.length >= 4 &&
      candidate.length <= 30 &&
      /\d/.test(candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}

function chooseVisibleLorryReceiptReference(
  current: string | undefined,
  visible: string | undefined,
) {
  if (!visible) return current;
  if (!current) return visible;

  const currentNormalized = normalizeLorryReferenceForDisplay(current);
  const visibleNormalized = normalizeLorryReferenceForDisplay(visible);
  if (currentNormalized === visibleNormalized) return current;
  if (currentNormalized === visibleNormalized + "LR") return visible;
  if (
    visibleNormalized.length > currentNormalized.length &&
    (visibleNormalized.startsWith(currentNormalized) ||
      visibleNormalized.endsWith(currentNormalized))
  ) {
    return visible;
  }
  return current;
}

function isCarrierHeaderGstin(
  markdown: string,
  supplierGstin: string | undefined,
) {
  const gstin = normalizeGstinIdentity(supplierGstin);
  if (!gstin || gstin.length !== 15) return false;

  const visibleText = getVisibleTextFromMarkdown(markdown);
  if (
    /\bconsign(?:or|er)(?:'s)?\s+gst(?:in|\s+reg(?:istration)?\s+no\.?)/i.test(
      visibleText,
    )
  ) {
    return false;
  }

  const gstinPan = gstin.slice(2, 12);
  return new RegExp(
    `\\bPAN\\s*(?:No\\.?|Number)?\\s*[:#|.=-]*\\s*${gstinPan}\\b`,
    "i",
  ).test(visibleText);
}

function enrichLorryReceiptCoreFields(documents: CaseDoc[]) {
  return documents.map((doc) => {
    if (doc.type !== "Lorry Receipt" || !doc.md?.trim()) return doc;

    const fields = { ...doc.fields };
    const lorryReceiptNumber = chooseVisibleLorryReceiptReference(
      fields.lorryReceiptNumber,
      extractVisibleLorryReceiptReference(doc.md),
    );
    const qualityIssues = [...(doc.qualityIssues ?? [])];
    if (isCarrierHeaderGstin(doc.md, fields.supplierGstin)) {
      addQualityIssue(
        qualityIssues,
        "supplierGstin",
        fields.supplierGstin ?? "<missing>",
        "corrected",
        "Removed a PAN-linked carrier header GSTIN that was not explicitly labelled as the consignor GSTIN.",
      );
      delete fields.supplierGstin;
    }
    if (
      lorryReceiptNumber &&
      lorryReceiptNumber !== fields.lorryReceiptNumber
    ) {
      addQualityIssue(
        qualityIssues,
        "lorryReceiptNumber",
        fields.lorryReceiptNumber ?? "<missing>",
        "corrected",
        "Recovered the complete LR/consignment reference printed after the document's LR label.",
      );
      fields.lorryReceiptNumber = lorryReceiptNumber;
    }
    if (!fields.referenceInvoiceNumber) {
      fields.referenceInvoiceNumber = extractVisibleLorryInvoiceReference(
        doc.md,
      );
    }
    if (!fields.totalAmount) {
      fields.totalAmount = extractVisibleLorryInvoiceValue(doc.md);
    }
    Object.keys(fields).forEach((key) => {
      if (!fields[key as FieldKey]) delete fields[key as FieldKey];
    });
    return areFieldRecordsEqual(doc.fields, fields)
      ? doc
      : { ...doc, fields, qualityIssues };
  });
}

function extractVisibleInvoiceLorryReference(markdown: string | undefined) {
  const visibleText = getVisibleTextFromMarkdown(markdown);
  const value = visibleText.match(
    /\b(?:LR\s*\/\s*RR|LR|Lorry\s+Receipt|Consignment\s+Note)\s*(?:No\.?|Number)\s*[:#|.=-]*\s*([A-Z0-9][A-Z0-9/-]{2,})/i,
  )?.[1];
  return value?.replace(/[.,;]+$/, "").trim();
}

function extractVisibleInvoiceWeight(
  markdown: string | undefined,
  label: "gross" | "tare" | "net",
) {
  const visibleText = normalizeOcrWeightLetters(
    getVisibleTextFromMarkdown(markdown),
  );
  const match = visibleText.match(
    new RegExp(
      `\\b${label}\\s+(?:weight|wt\\.?)\\s*[:#|.=-]*\\s*(-?\\d[\\d,]*(?:\\.\\d+)?)\\s*\\(?\\s*(kg|kgs|m\\.?t\\.?s?\\.?|to|tonnes?)\\s*\\)?`,
      "i",
    ),
  );
  const unit = normalizeWeightUnitToken(match?.[2] ?? "");
  const value = parseLooseNumber(match?.[1]);
  return unit && value !== null
    ? `${formatNumberForField(value)} ${unit}`
    : undefined;
}

function enrichInvoiceLogisticsFields(documents: CaseDoc[]) {
  return documents.map((doc) => {
    if (!isInvoiceDocType(doc.type) || !doc.md?.trim()) return doc;

    const fields = { ...doc.fields };
    fields.lorryReceiptNumber ??= extractVisibleInvoiceLorryReference(doc.md);
    fields.grossWeight ??= extractVisibleInvoiceWeight(doc.md, "gross");
    fields.tareWeight ??= extractVisibleInvoiceWeight(doc.md, "tare");
    fields.netWeight ??= extractVisibleInvoiceWeight(doc.md, "net");
    Object.keys(fields).forEach((key) => {
      if (!fields[key as FieldKey]) delete fields[key as FieldKey];
    });
    return areFieldRecordsEqual(doc.fields, fields) ? doc : { ...doc, fields };
  });
}

const IRN_DOCUMENT_TYPES = new Set<DocType>([
  "Invoice",
  "Tax Invoice",
  "E-Way Bill",
]);

function extractVisibleIrn(markdown: string | undefined) {
  const visibleText = getVisibleTextFromMarkdown(markdown);
  const irnIndex = visibleText.search(/\bIRN\s*:?/i);
  if (irnIndex < 0) return undefined;

  const window = visibleText.slice(irnIndex, irnIndex + 1400);
  const direct = window.match(/\bIRN\s*:?\s*((?:[A-F0-9]\s*){64})/i);
  const directValue = direct?.[1]?.replace(/\s+/g, "").toLowerCase();
  if (directValue && /^[a-f0-9]{64}$/.test(directValue)) return directValue;

  // Multi-column OCR can insert nearby address labels between a wrapped IRN's
  // first line and its short continuation. Join only long hexadecimal runs
  // after the explicit label and accept a result only at exactly 64 chars.
  const fragments = [...window.matchAll(/\b[a-f0-9]{8,64}\b/gi)].map((match) =>
    match[0].toLowerCase(),
  );
  for (let start = 0; start < fragments.length; start += 1) {
    if (fragments[start].length < 32) continue;
    let candidate = "";
    for (let index = start; index < fragments.length; index += 1) {
      candidate += fragments[index];
      if (candidate.length === 64) return candidate;
      if (candidate.length > 64) break;
    }
  }
  return undefined;
}

function enrichIrnNumbers(documents: CaseDoc[]) {
  return documents.map((doc) => {
    if (!IRN_DOCUMENT_TYPES.has(doc.type)) return doc;
    // A complete IRN already extracted from the source image is stronger
    // evidence than the model-generated Visible Text transcription. OCR can
    // confuse a leading "b" with "6", so never overwrite one valid hash with
    // another. Cross-document verification will surface genuinely conflicting
    // complete IRNs for human review.
    if (/^[a-f0-9]{64}$/i.test(doc.fields.irnNumber?.trim() ?? "")) {
      return doc;
    }
    const visibleIrn = extractVisibleIrn(doc.md);
    if (!visibleIrn || doc.fields.irnNumber === visibleIrn) return doc;

    const qualityIssues = [...(doc.qualityIssues ?? [])];
    addQualityIssue(
      qualityIssues,
      "irnNumber",
      doc.fields.irnNumber ?? "<missing>",
      "corrected",
      "Recovered the complete 64-character IRN printed beside the IRN label.",
    );
    return {
      ...doc,
      fields: { ...doc.fields, irnNumber: visibleIrn },
      qualityIssues,
    };
  });
}

const LINKED_LOGISTICS_DOC_TYPES = new Set<DocType>([
  "Invoice",
  "Tax Invoice",
  "E-Way Bill",
  "Lorry Receipt",
]);

function getLinkedInvoiceIdentity(doc: CaseDoc) {
  return normalizeInvoiceIdentity(
    isInvoiceDocType(doc.type)
      ? doc.fields.invoiceNumber
      : doc.fields.referenceInvoiceNumber,
  );
}

function groupDocumentsByInvoiceIdentity(documents: CaseDoc[]) {
  const groups = new Map<string, CaseDoc[]>();
  for (const doc of documents) {
    if (!LINKED_LOGISTICS_DOC_TYPES.has(doc.type)) continue;
    const identity = getLinkedInvoiceIdentity(doc);
    if (!identity) continue;
    const group = groups.get(identity) ?? [];
    group.push(doc);
    groups.set(identity, group);
  }
  return groups;
}

function appendPacketConsensusCorrection(
  doc: CaseDoc,
  field: FieldKey,
  value: string,
  reason: string,
) {
  const currentValue = doc.fields[field];
  if (currentValue === value) return doc;

  const qualityIssues = [...(doc.qualityIssues ?? [])];
  appendReviewQualityIssue(
    qualityIssues,
    field,
    currentValue ?? "<missing>",
    "corrected",
    reason,
  );
  return {
    ...doc,
    fields: { ...doc.fields, [field]: value },
    qualityIssues,
  };
}

function enrichLinkedIrnConsensus(documents: CaseDoc[]) {
  const groups = groupDocumentsByInvoiceIdentity(documents);
  const consensusByInvoice = new Map<string, string>();

  for (const [identity, group] of groups) {
    const irns = [
      ...new Set(
        group
          .map((doc) => doc.fields.irnNumber?.trim().toLowerCase())
          .filter((value): value is string =>
            Boolean(value && /^[a-f0-9]{64}$/.test(value)),
          ),
      ),
    ];
    if (group.length >= 2 && irns.length === 1) {
      consensusByInvoice.set(identity, irns[0]);
    }
  }

  return documents.map((doc) => {
    if (
      !IRN_DOCUMENT_TYPES.has(doc.type) ||
      !getFieldKeysForDocType(doc.type).includes("irnNumber") ||
      /^[a-f0-9]{64}$/i.test(doc.fields.irnNumber?.trim() ?? "")
    ) {
      return doc;
    }
    const identity = getLinkedInvoiceIdentity(doc);
    const consensus = identity ? consensusByInvoice.get(identity) : undefined;
    if (!consensus) return doc;

    const current = doc.fields.irnNumber
      ?.toLowerCase()
      .replace(/[^a-f0-9]/g, "");
    if (
      current &&
      current.length >= 16 &&
      !consensus.startsWith(current) &&
      !consensus.endsWith(current)
    ) {
      return doc;
    }

    return appendPacketConsensusCorrection(
      doc,
      "irnNumber",
      consensus,
      "Restored from the unique valid IRN shared by documents with the same invoice reference.",
    );
  });
}

function getUniqueRepeatedFieldValue(documents: CaseDoc[], field: FieldKey) {
  const values = new Map<string, { value: string; docIds: Set<string> }>();
  for (const doc of documents) {
    const value = doc.fields[field]?.trim();
    const normalized = normalizePacketValue(value, field);
    if (!value || !normalized) continue;
    const entry = values.get(normalized) ?? {
      value,
      docIds: new Set<string>(),
    };
    entry.docIds.add(doc.id);
    values.set(normalized, entry);
  }
  const repeated = [...values.values()].filter(
    (entry) => entry.docIds.size >= 2,
  );
  return repeated.length === 1 ? repeated[0].value : undefined;
}

function enrichLinkedLorryReceiptConsensus(documents: CaseDoc[]) {
  const groups = groupDocumentsByInvoiceIdentity(documents);
  const consensusByInvoice = new Map<string, string>();
  for (const [identity, group] of groups) {
    const consensus = getUniqueRepeatedFieldValue(group, "lorryReceiptNumber");
    if (consensus) consensusByInvoice.set(identity, consensus);
  }

  return documents.map((doc) => {
    if (
      !LINKED_LOGISTICS_DOC_TYPES.has(doc.type) ||
      !getFieldKeysForDocType(doc.type).includes("lorryReceiptNumber") ||
      doc.fields.lorryReceiptNumber
    ) {
      return doc;
    }
    const identity = getLinkedInvoiceIdentity(doc);
    const consensus = identity ? consensusByInvoice.get(identity) : undefined;
    return consensus
      ? appendPacketConsensusCorrection(
          doc,
          "lorryReceiptNumber",
          consensus,
          "Restored because at least two linked logistics documents show the same LR/consignment reference for this invoice.",
        )
      : doc;
  });
}

function normalizeEntityConsensusName(value: string | undefined) {
  return value
    ?.toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isCompatibleEntityNameExpansion(shorter: string, longer: string) {
  return (
    shorter.length >= 8 &&
    shorter.split(" ").length >= 2 &&
    (longer === shorter ||
      longer.startsWith(`${shorter} `) ||
      longer.endsWith(` ${shorter}`))
  );
}

function documentsShareLogisticsAnchor(left: CaseDoc, right: CaseDoc) {
  const leftInvoice = getLinkedInvoiceIdentity(left);
  const rightInvoice = getLinkedInvoiceIdentity(right);
  if (leftInvoice && rightInvoice && leftInvoice === rightInvoice) return true;

  return (
    ["lorryReceiptNumber", "vehicleNumber", "eWayBillNumber"] as const
  ).some((field) => {
    const leftValue = normalizePacketValue(left.fields[field], field);
    const rightValue = normalizePacketValue(right.fields[field], field);
    return Boolean(leftValue && rightValue && leftValue === rightValue);
  });
}

function enrichLinkedTransporterNames(documents: CaseDoc[]) {
  return documents.map((doc) => {
    if (
      !["E-Way Bill", "Lorry Receipt"].includes(doc.type) ||
      !getFieldKeysForDocType(doc.type).includes("transporterName")
    ) {
      return doc;
    }

    const candidates = documents
      .filter(
        (candidate) =>
          candidate.fields.transporterName &&
          documentsShareLogisticsAnchor(doc, candidate),
      )
      .map((candidate) => candidate.fields.transporterName?.trim())
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => right.length - left.length);
    if (candidates.length < 2) return doc;

    const longest = candidates[0];
    const longestNormalized = normalizeEntityConsensusName(longest);
    const currentNormalized = normalizeEntityConsensusName(
      doc.fields.transporterName,
    );
    if (!longestNormalized || !currentNormalized) return doc;

    const allCompatible = candidates.every((candidate) => {
      const normalized = normalizeEntityConsensusName(candidate);
      if (!normalized) return false;
      const [shorter, longer] =
        normalized.length <= longestNormalized.length
          ? [normalized, longestNormalized]
          : [longestNormalized, normalized];
      return isCompatibleEntityNameExpansion(shorter, longer);
    });
    if (
      !allCompatible ||
      currentNormalized === longestNormalized ||
      !isCompatibleEntityNameExpansion(currentNormalized, longestNormalized)
    ) {
      return doc;
    }

    return appendPacketConsensusCorrection(
      doc,
      "transporterName",
      longest,
      "Expanded the transporter name from a linked logistics document with matching invoice, LR, vehicle, or E-Way evidence.",
    );
  });
}

function enrichPacketPartyConsensusValues(documents: CaseDoc[]) {
  const withGstinConsensus = enrichGstinConsensusValues(documents);
  return withGstinConsensus.map((doc) => {
    const allowedFields = new Set(getFieldKeysForDocType(doc.type));
    let next = doc;
    if (
      allowedFields.has("vendorName") &&
      !next.fields.vendorName &&
      next.fields.supplierGstin
    ) {
      const vendorName = getBestPartyNameByGstin(
        withGstinConsensus,
        "supplierGstin",
        "vendorName",
        next.fields.supplierGstin,
      );
      if (vendorName) {
        next = appendPacketConsensusCorrection(
          next,
          "vendorName",
          vendorName,
          "Restored from a linked invoice or purchase order with the same supplier GSTIN.",
        );
      }
    }
    if (
      allowedFields.has("buyerName") &&
      !next.fields.buyerName &&
      next.fields.buyerGstin
    ) {
      const buyerName = getBestPartyNameByGstin(
        withGstinConsensus,
        "buyerGstin",
        "buyerName",
        next.fields.buyerGstin,
      );
      if (buyerName) {
        next = appendPacketConsensusCorrection(
          next,
          "buyerName",
          buyerName,
          "Restored from a linked invoice or purchase order with the same buyer GSTIN.",
        );
      }
    }
    return next;
  });
}

function getMajorityLinkedPartyName(
  documents: CaseDoc[],
  field: "vendorName" | "buyerName",
) {
  const counts = new Map<
    string,
    { value: string; count: number; normalized: string }
  >();
  for (const doc of documents) {
    const value = doc.fields[field]?.trim();
    const normalized = normalizeEntityConsensusName(value);
    if (!value || !normalized) continue;
    const current = counts.get(normalized) ?? {
      value,
      count: 0,
      normalized,
    };
    current.count += 1;
    if (value.length > current.value.length) current.value = value;
    counts.set(normalized, current);
  }

  const ranked = [...counts.values()].sort(
    (left, right) =>
      right.count - left.count || right.value.length - left.value.length,
  );
  if (
    !ranked[0] ||
    ranked[0].count < 2 ||
    (ranked[1] && ranked[1].count === ranked[0].count)
  ) {
    return undefined;
  }
  return ranked[0];
}

function isCorrectableLinkedPartyOcrName(current: string, expected: string) {
  const currentWords = current.split(" ");
  const expectedWords = expected.split(" ");
  if (!currentWords[0] || currentWords[0] !== expectedWords[0]) return false;

  const maxLength = Math.max(current.length, expected.length);
  return (
    editDistanceValue(current, expected) <=
    Math.max(2, Math.floor(maxLength * 0.12))
  );
}

function enrichLinkedPartyNameConsensus(documents: CaseDoc[]) {
  const groups = groupDocumentsByInvoiceIdentity(documents);
  const consensus = new Map<
    string,
    Partial<
      Record<"vendorName" | "buyerName", { value: string; normalized: string }>
    >
  >();
  for (const [identity, group] of groups) {
    const vendorName = getMajorityLinkedPartyName(group, "vendorName");
    const buyerName = getMajorityLinkedPartyName(group, "buyerName");
    consensus.set(identity, {
      ...(vendorName ? { vendorName } : {}),
      ...(buyerName ? { buyerName } : {}),
    });
  }

  return documents.map((doc) => {
    const identity = getLinkedInvoiceIdentity(doc);
    const names = identity ? consensus.get(identity) : undefined;
    if (!names) return doc;

    let next = doc;
    for (const field of ["vendorName", "buyerName"] as const) {
      const currentValue = next.fields[field];
      const expected = names[field];
      const currentNormalized = normalizeEntityConsensusName(currentValue);
      if (
        !currentValue ||
        !currentNormalized ||
        !expected ||
        currentNormalized === expected.normalized ||
        !isCorrectableLinkedPartyOcrName(currentNormalized, expected.normalized)
      ) {
        continue;
      }
      next = appendPacketConsensusCorrection(
        next,
        field,
        expected.value,
        "Corrected a small party-name OCR error using the majority value from documents with the same invoice reference.",
      );
    }
    return next;
  });
}

function enrichLinkedPacketConsensus(documents: CaseDoc[]) {
  return enrichLinkedPartyNameConsensus(
    enrichPacketPartyConsensusValues(
      enrichLinkedTransporterNames(
        enrichLinkedLorryReceiptConsensus(enrichLinkedIrnConsensus(documents)),
      ),
    ),
  );
}

function enrichPurchaseOrderCoreFields(documents: CaseDoc[]) {
  return documents.map((doc) => {
    if (!isPurchaseOrderDocType(doc.type)) return doc;

    const fields = removeNonRequiredPurchaseOrderPresenceFields(
      applyPurchaseOrderDateFallback(doc.fields, doc.type, doc.md ?? ""),
      doc.type,
    );
    return areFieldRecordsEqual(doc.fields, fields) ? doc : { ...doc, fields };
  });
}

function normalizeVehicleNumberForDisplay(value: string | undefined) {
  const normalized = normalizePacketValue(value, "vehicleNumber");
  return normalized && /^[a-z]{2}\d{1,2}[a-z]{1,3}\d{3,4}$/i.test(normalized)
    ? normalized.toUpperCase()
    : value;
}

function isValidIndianVehicleNumber(value: string | undefined) {
  const normalized = normalizePacketValue(value, "vehicleNumber");
  return Boolean(
    normalized && /^[a-z]{2}\d{1,2}[a-z]{1,3}\d{3,4}$/i.test(normalized),
  );
}

function isNumericOnlyIdentifier(value: string | undefined) {
  return Boolean(
    value &&
    /^\d{5,14}$/.test(value.replace(/\D/g, "")) &&
    !/[a-z]/i.test(value),
  );
}

function vehicleCore(value: string | undefined) {
  const normalized = normalizeVehicleNumberForDisplay(value);
  if (!normalized) return null;
  const compact = normalized.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.match(/^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{3,4})$/);
}

function editDistanceValue(left: string, right: string) {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function normalizeWeighmentVehicleOcrText(value: string) {
  return value
    .toUpperCase()
    .replace(/[ΑА]/g, "A")
    .replace(/[ΒВ]/g, "B")
    .replace(/[СϹ]/g, "C")
    .replace(/[ΕЕ]/g, "E")
    .replace(/[ΗН]/g, "H")
    .replace(/[ΙІ]/g, "I")
    .replace(/[ΚК]/g, "K")
    .replace(/[ΜМ]/g, "M")
    .replace(/[ΝИ]/g, "N")
    .replace(/[ΟО]/g, "O")
    .replace(/[ΡР]/g, "P")
    .replace(/[ΤТ]/g, "T")
    .replace(/[ΥУ]/g, "Y")
    .replace(/[ΧХ]/g, "X");
}

function extractLooseVehicleCandidates(value: string) {
  const normalized = normalizeWeighmentVehicleOcrText(value);
  const candidates = [
    ...normalized.matchAll(
      /\b([A-Z]{1,2})\s*[-.]?\s*(\d{1,2})\s*[-.]?\s*([A-Z]{1,3})\s*[-.]?\s*(\d{3,4})\b/g,
    ),
  ]
    .map((match) =>
      `${match[1]}${match[2]}${match[3]}${match[4]}`.toUpperCase(),
    )
    .filter((candidate) =>
      /[A-Z]{1,2}\d{1,2}[A-Z]{1,3}\d{3,4}/.test(candidate),
    );
  return [...new Set(candidates)];
}

function looseVehicleSupportsCanonical(
  candidate: string,
  canonicalVehicle: string,
) {
  const canonical = vehicleCore(canonicalVehicle);
  const loose = candidate.match(/^([A-Z]{1,2})(\d{1,2})([A-Z]{1,3})(\d{3,4})$/);
  if (!canonical || !loose) return false;

  const [
    ,
    canonicalState,
    canonicalDistrict,
    canonicalSeries,
    canonicalNumber,
  ] = canonical;
  const [, looseState, looseDistrict, looseSeries, looseNumber] = loose;
  if (canonicalDistrict !== looseDistrict) return false;

  const stateClose =
    canonicalState === looseState ||
    canonicalState.endsWith(looseState) ||
    looseState.endsWith(canonicalState) ||
    editDistanceValue(canonicalState, looseState) <= 1;
  if (!stateClose) return false;

  if (canonicalNumber === looseNumber) {
    return (
      editDistanceValue(canonicalSeries, looseSeries) <=
      Math.max(1, canonicalSeries.length - 1)
    );
  }

  return (
    canonicalSeries === looseSeries &&
    editDistanceValue(canonicalNumber, looseNumber) <= 1
  );
}

function weighmentTextSupportsVehicle(doc: CaseDoc, vehicleNumber: string) {
  const normalizedVehicle = normalizeVehicleNumberForDisplay(vehicleNumber);
  if (!normalizedVehicle) return false;
  const compactVisibleText = normalizeWeighmentVehicleOcrText(
    doc.md ?? "",
  ).replace(/[^A-Z0-9]/g, "");
  if (compactVisibleText.includes(normalizedVehicle)) return true;
  return extractLooseVehicleCandidates(doc.md ?? "").some((candidate) =>
    looseVehicleSupportsCanonical(candidate, normalizedVehicle),
  );
}

function getVehicleConsensus(documents: CaseDoc[]) {
  const scores = new Map<
    string,
    {
      value: string;
      score: number;
      docIds: Set<string>;
      docTypes: Set<DocType>;
    }
  >();

  for (const doc of documents) {
    if (doc.type === "Weighment Slip") continue;
    const weight = VEHICLE_CONSENSUS_DOC_TYPE_WEIGHT[doc.type] ?? 0;
    if (!weight) continue;
    const displayValue = normalizeVehicleNumberForDisplay(
      doc.fields.vehicleNumber ?? doc.fields.registrationNumber,
    );
    const normalizedValue = normalizePacketValue(displayValue, "vehicleNumber");
    if (!displayValue || !normalizedValue) continue;
    const current = scores.get(normalizedValue) ?? {
      value: displayValue,
      score: 0,
      docIds: new Set<string>(),
      docTypes: new Set<DocType>(),
    };
    current.score += weight;
    current.docIds.add(doc.id);
    current.docTypes.add(doc.type);
    scores.set(normalizedValue, current);
  }

  return [...scores.values()]
    .filter(
      (entry) =>
        entry.docIds.size >= 2 ||
        (entry.docTypes.has("E-Way Bill") && entry.score >= 4) ||
        ((entry.docTypes.has("Invoice") || entry.docTypes.has("Tax Invoice")) &&
          entry.score >= 3),
    )
    .sort(
      (left, right) =>
        right.score - left.score || right.docIds.size - left.docIds.size,
    )[0];
}

function enrichWeighmentVehicleNumbers(documents: CaseDoc[]) {
  const consensus = getVehicleConsensus(documents);
  if (!consensus) return documents;

  return documents.map((doc) => {
    if (doc.type !== "Weighment Slip") return doc;
    const consensusVehicle = normalizeVehicleNumberForDisplay(consensus.value);
    if (
      !consensusVehicle ||
      !weighmentTextSupportsVehicle(doc, consensusVehicle)
    )
      return doc;

    const currentVehicle = normalizeVehicleNumberForDisplay(
      doc.fields.vehicleNumber,
    );
    if (currentVehicle === consensusVehicle) return doc;

    return {
      ...doc,
      fields: {
        ...doc.fields,
        vehicleNumber: consensusVehicle,
      },
    };
  });
}

function isCorrectableVehicleOcrValue(
  current: string | undefined,
  consensus: string,
) {
  if (!current) return false;

  const currentCompact = normalizeWeighmentVehicleOcrText(current).replace(
    /[^A-Z0-9]/g,
    "",
  );
  const consensusCompact = normalizeVehicleNumberForDisplay(consensus)
    ?.toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (
    !currentCompact ||
    !consensusCompact ||
    currentCompact === consensusCompact
  )
    return false;
  if (!currentCompact.startsWith(consensusCompact.slice(0, 2))) return false;
  if (currentCompact.slice(-4) !== consensusCompact.slice(-4)) return false;

  return editDistanceValue(currentCompact, consensusCompact) <= 3;
}

function enrichCorroboratedVehicleNumbers(documents: CaseDoc[]) {
  const consensus = getVehicleConsensus(documents);
  const consensusVehicle = normalizeVehicleNumberForDisplay(consensus?.value);
  if (!consensusVehicle) return documents;

  return documents.map((doc) => {
    if (!VEHICLE_OCR_CORRECTABLE_DOC_TYPES.has(doc.type)) return doc;

    const currentVehicle = normalizeVehicleNumberForDisplay(
      doc.fields.vehicleNumber,
    );
    if (currentVehicle === consensusVehicle) return doc;

    const supportedByText = weighmentTextSupportsVehicle(doc, consensusVehicle);
    const supportedByOcrShape = isCorrectableVehicleOcrValue(
      doc.fields.vehicleNumber,
      consensusVehicle,
    );
    if (!supportedByText && !supportedByOcrShape) return doc;

    return {
      ...doc,
      fields: {
        ...doc.fields,
        vehicleNumber: consensusVehicle,
      },
    };
  });
}

function normalizeGstinForDisplay(
  value: string | undefined,
  field: "supplierGstin" | "buyerGstin",
) {
  const normalized = normalizeComparableValue(
    value,
    DEFAULT_COMPARISON_OPTIONS,
    field,
  );
  return normalized && /^[0-9A-Z]{15}$/.test(normalized) ? normalized : value;
}

const GSTIN_CONSENSUS_FIELDS = ["supplierGstin", "buyerGstin"] as const;

const GSTIN_VALUE_SOURCE = "([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z])";

function extractRoleLabelledGstin(
  doc: CaseDoc,
  field: (typeof GSTIN_CONSENSUS_FIELDS)[number],
) {
  const visibleText = getVisibleTextFromMarkdown(doc.md).toUpperCase();
  if (!visibleText.trim()) return undefined;

  const role =
    field === "supplierGstin"
      ? "(?:SUPPLIER|SELLER|VENDOR|CONSIGNOR)"
      : "(?:BUYER|CUSTOMER|CONSIGNEE|RECIPIENT|BILL\\s*TO|SHIP\\s*TO)";
  const gstLabel = "GST(?:IN)?(?:\\s*\\/\\s*UIN)?|GST\\s*(?:NO\\.?|NUMBER)";
  const patterns = [
    new RegExp(
      "\\b" +
        role +
        "(?:'S)?\\s+(?:" +
        gstLabel +
        ")\\s*[:#|.=-]*\\s*" +
        GSTIN_VALUE_SOURCE +
        "\\b",
      "i",
    ),
    new RegExp(
      "\\b(?:" +
        gstLabel +
        ")(?:\\s+OF)?\\s+" +
        role +
        "\\s*[:#|.=-]*\\s*" +
        GSTIN_VALUE_SOURCE +
        "\\b",
      "i",
    ),
    new RegExp(
      "\\b" +
        role +
        "\\b(?:(?!\\b(?:SUPPLIER|SELLER|VENDOR|CONSIGNOR|BUYER|CUSTOMER|CONSIGNEE|RECIPIENT|BILL\\s*TO|SHIP\\s*TO)\\b)[\\s\\S]){0,160}?\\b(?:" +
        gstLabel +
        ")\\s*[:#|.=-]*\\s*" +
        GSTIN_VALUE_SOURCE +
        "\\b",
      "i",
    ),
  ];

  for (const pattern of patterns) {
    const value = visibleText.match(pattern)?.[1];
    if (value) return value;
  }
  return undefined;
}

function applyRoleLabelledGstinEvidence(documents: CaseDoc[]) {
  return documents.map((doc) => {
    const fields = { ...doc.fields };
    let changed = false;
    for (const field of GSTIN_CONSENSUS_FIELDS) {
      const sourceValue = extractRoleLabelledGstin(doc, field);
      if (sourceValue && fields[field] !== sourceValue) {
        fields[field] = sourceValue;
        changed = true;
      }
    }
    return changed ? { ...doc, fields } : doc;
  });
}

function getGstinConsensus(
  documents: CaseDoc[],
  field: (typeof GSTIN_CONSENSUS_FIELDS)[number],
) {
  const counts = new Map<string, { value: string; docIds: Set<string> }>();
  for (const doc of documents) {
    const value = normalizeGstinForDisplay(doc.fields[field], field);
    if (!value) continue;
    const current = counts.get(value) ?? { value, docIds: new Set<string>() };
    current.docIds.add(doc.id);
    counts.set(value, current);
  }

  return [...counts.values()]
    .filter((entry) => entry.docIds.size >= 2)
    .sort((left, right) => right.docIds.size - left.docIds.size)[0]?.value;
}

function isCorrectableGstinOcrValue(
  current: string | undefined,
  consensus: string,
) {
  if (!current || current.length !== 15 || consensus.length !== 15)
    return false;
  return (
    current.slice(0, 2) === consensus.slice(0, 2) &&
    editDistanceValue(current, consensus) <= 2
  );
}

function enrichGstinConsensusValues(documents: CaseDoc[]) {
  const sourceGroundedDocuments = applyRoleLabelledGstinEvidence(documents);
  const consensusByField = Object.fromEntries(
    GSTIN_CONSENSUS_FIELDS.map((field) => [
      field,
      getGstinConsensus(sourceGroundedDocuments, field),
    ]),
  ) as Partial<Record<(typeof GSTIN_CONSENSUS_FIELDS)[number], string>>;

  if (!Object.values(consensusByField).some(Boolean)) {
    return sourceGroundedDocuments;
  }

  return sourceGroundedDocuments.map((doc) => {
    const fields = { ...doc.fields };
    let changed = false;

    for (const field of GSTIN_CONSENSUS_FIELDS) {
      const consensus = consensusByField[field];
      const current = normalizeGstinForDisplay(fields[field], field);
      const labelledSourceValue = extractRoleLabelledGstin(doc, field);
      if (
        consensus &&
        current !== consensus &&
        !labelledSourceValue &&
        isCorrectableGstinOcrValue(current, consensus)
      ) {
        fields[field] = consensus;
        changed = true;
      }
    }

    return changed ? { ...doc, fields } : doc;
  });
}

function normalizeEWayBillNumberForDisplay(value: string | undefined) {
  if (!value) return value;
  const digits = value.replace(/\D/g, "");
  return digits.length === 12 ? digits : value;
}

function getValidEWayBillNumber(value: string | undefined) {
  const digits = value?.replace(/\D/g, "");
  return digits && digits.length === 12 ? digits : undefined;
}

function normalizeInvoiceLikeReference(value: string | undefined) {
  const compact = value?.toUpperCase().replace(/[^A-Z0-9/-]/g, "") ?? "";
  return compact &&
    /[A-Z]/.test(compact) &&
    /\d/.test(compact) &&
    compact.length >= 5
    ? compact
    : undefined;
}

function addQualityIssue(
  issues: ExtractionQualityIssue[],
  field: FieldKey,
  originalValue: string,
  action: ExtractionQualityIssue["action"],
  reason: string,
  targetField?: FieldKey,
) {
  issues.push({
    field,
    originalValue,
    action,
    ...(targetField ? { targetField } : {}),
    reason,
  });
}

function applyIdentifierQualityGuard(doc: CaseDoc): CaseDoc {
  const fields = { ...doc.fields };
  const qualityIssues = [...(doc.qualityIssues ?? [])];
  let changed = false;

  if (
    fields.vehicleNumber &&
    !isValidIndianVehicleNumber(fields.vehicleNumber)
  ) {
    const originalValue = fields.vehicleNumber;
    if (
      doc.type === "Weighment Slip" &&
      isNumericOnlyIdentifier(originalValue) &&
      !fields.weighmentNumber
    ) {
      fields.weighmentNumber = originalValue.replace(/\D/g, "");
      addQualityIssue(
        qualityIssues,
        "vehicleNumber",
        originalValue,
        "moved",
        "Numeric-only lorry/weighment value is not a valid Indian vehicle registration.",
        "weighmentNumber",
      );
    } else {
      addQualityIssue(
        qualityIssues,
        "vehicleNumber",
        originalValue,
        "quarantined",
        "Value is not a valid Indian vehicle registration and was excluded from packet comparison.",
      );
    }
    delete fields.vehicleNumber;
    changed = true;
  }

  if (
    fields.registrationNumber &&
    !isValidIndianVehicleNumber(fields.registrationNumber)
  ) {
    const originalValue = fields.registrationNumber;
    addQualityIssue(
      qualityIssues,
      "registrationNumber",
      originalValue,
      "quarantined",
      "Registration value is not a valid Indian vehicle registration and was excluded from packet comparison.",
    );
    delete fields.registrationNumber;
    changed = true;
  }

  if (fields.eWayBillNumber && !getValidEWayBillNumber(fields.eWayBillNumber)) {
    const originalValue = fields.eWayBillNumber;
    const invoiceLikeReference = normalizeInvoiceLikeReference(originalValue);
    if (
      doc.type === "E-Way Bill" &&
      invoiceLikeReference &&
      !fields.referenceInvoiceNumber
    ) {
      fields.referenceInvoiceNumber = invoiceLikeReference;
      addQualityIssue(
        qualityIssues,
        "eWayBillNumber",
        originalValue,
        "moved",
        "E-Way Bill number must be 12 digits; this value looks like a document or invoice reference.",
        "referenceInvoiceNumber",
      );
    } else {
      addQualityIssue(
        qualityIssues,
        "eWayBillNumber",
        originalValue,
        "quarantined",
        "E-Way Bill number must be 12 digits and was excluded from packet comparison.",
      );
    }
    delete fields.eWayBillNumber;
    changed = true;
  }

  return changed ? { ...doc, fields, qualityIssues } : doc;
}

function applyIdentifierQualityGuards(documents: CaseDoc[]) {
  return documents.map(applyIdentifierQualityGuard);
}

function visibleTextSupportsEWayBillNumber(
  doc: CaseDoc,
  eWayBillNumber: string,
) {
  return (doc.md ?? "").replace(/\D/g, "").includes(eWayBillNumber);
}

function getEWayBillNumberConsensus(documents: CaseDoc[]) {
  const counts = new Map<string, { value: string; score: number }>();

  for (const doc of documents) {
    const value = getValidEWayBillNumber(doc.fields.eWayBillNumber);
    if (!value) continue;
    const current = counts.get(value) ?? { value, score: 0 };
    current.score += doc.type === "E-Way Bill" ? 5 : 1;
    counts.set(value, current);
  }

  return [...counts.values()].sort((left, right) => right.score - left.score)[0]
    ?.value;
}

function enrichInvoiceEWayBillNumbers(documents: CaseDoc[]) {
  const consensus = getEWayBillNumberConsensus(documents);
  if (!consensus) return documents;

  return documents.map((doc) => {
    if (!isInvoiceDocType(doc.type)) return doc;
    const current = getValidEWayBillNumber(doc.fields.eWayBillNumber);
    if (current === consensus) return doc;
    if (current && current !== consensus) return doc;

    const irnFieldHasConsensus =
      getValidEWayBillNumber(doc.fields.irnNumber) === consensus;
    if (
      !irnFieldHasConsensus &&
      !visibleTextSupportsEWayBillNumber(doc, consensus)
    )
      return doc;

    return {
      ...doc,
      fields: {
        ...doc.fields,
        eWayBillNumber: consensus,
      },
    };
  });
}

function normalizeCompactReferenceForDisplay(value: string | undefined) {
  if (!value) return value;
  const compact = value.toUpperCase().replace(/\s+/g, "");
  return /[A-Z]/.test(compact) && /\d/.test(compact) ? compact : value;
}

function normalizeLineItemUnitForDisplay(value: string | undefined) {
  if (!value) return value;
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (
    [
      "ea",
      "each",
      "nos",
      "no",
      "nr",
      "number",
      "numbers",
      "pcs",
      "piece",
      "pieces",
      "pc",
    ].includes(compact)
  )
    return "Nos";
  if (["kg", "kgs", "kilogram", "kilograms"].includes(compact)) return "KG";
  if (
    [
      "mt",
      "mts",
      "mton",
      "mtons",
      "metricton",
      "metrictons",
      "metrictonne",
      "metrictonnes",
      "to",
      "tonne",
      "tonnes",
    ].includes(compact)
  )
    return "MT";
  if (["ltr", "liter", "litre", "liters", "litres"].includes(compact))
    return "LTR";
  return value;
}

function cleanVisibleItemCodeCandidate(value: string, hsnSac?: string) {
  const cleaned = value
    .replace(/^[•*\-\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > 80) return null;

  const compact = cleaned.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const hsnCompact = hsnSac?.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  if (!compact || compact === hsnCompact) return null;
  if (!/\d/.test(compact)) return null;
  if (/^\d{1,2}$/.test(compact)) return null;
  if (/^\d{1,2}%$/.test(cleaned)) return null;
  if (
    /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(cleaned) ||
    /^\d+\.\d{2}$/.test(cleaned)
  )
    return null;
  if (/^(?:hsn|sac|gst|qty|unit|nos|inr|rate|total|value)$/i.test(cleaned))
    return null;

  return cleaned;
}

function extractVisibleItemCodesBeforeHsn(
  visibleText: string,
  hsnSac?: string,
) {
  const hsnCompact = hsnSac?.replace(/\D/g, "");
  if (!visibleText.trim() || !hsnCompact || hsnCompact.length < 4) return [];

  const lines = visibleText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const codes: string[] = [];

  for (const [index, line] of lines.entries()) {
    if (!line.replace(/\D/g, "").startsWith(hsnCompact)) continue;

    for (
      let cursor = index - 1;
      cursor >= Math.max(0, index - 5);
      cursor -= 1
    ) {
      const candidate = cleanVisibleItemCodeCandidate(lines[cursor], hsnSac);
      if (!candidate) continue;
      codes.push(candidate);
      break;
    }
  }

  return codes;
}

function isWeakExtractedItemCode(value?: string, description?: string) {
  if (!value) return true;
  const compact = value.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  if (compact.length <= 2) return true;
  if (
    description &&
    compact === description.replace(/[^A-Z0-9]/gi, "").toUpperCase()
  )
    return true;
  return /\b(?:guide|roller|cylinder|gas|spares?|parts?)\b/i.test(value);
}

function fillVisibleItemCodes(
  lineItems: CommercialLineItem[] | undefined,
  visibleText: string,
) {
  if (!lineItems?.length || !visibleText.trim()) return lineItems;

  const codesByHsn = new Map<string, string[]>();
  let changed = false;

  const next = lineItems.map((item) => {
    const hsnKey = item.hsnSac?.replace(/\D/g, "");
    if (!hsnKey) return item;

    const codes =
      codesByHsn.get(hsnKey) ??
      extractVisibleItemCodesBeforeHsn(visibleText, item.hsnSac);
    codesByHsn.set(hsnKey, codes);
    const candidate = codes.shift();
    if (!isWeakExtractedItemCode(item.itemCode, item.description)) return item;
    if (!candidate || candidate === item.itemCode) return item;

    changed = true;
    return { ...item, itemCode: candidate };
  });

  return changed ? next : lineItems;
}

function normalizeLineItemDisplayFields(
  lineItems: CommercialLineItem[] | undefined,
  visibleText = "",
) {
  if (!lineItems?.length) return lineItems;

  const withVisibleCodes =
    fillVisibleItemCodes(lineItems, visibleText) ?? lineItems;
  let changed = false;
  const normalized = withVisibleCodes.map((item) => {
    const unit = normalizeLineItemUnitForDisplay(item.unit);
    if (!unit || unit === item.unit) return item;
    changed = true;
    return { ...item, unit };
  });

  return changed || withVisibleCodes !== lineItems ? normalized : lineItems;
}

function normalizeIdentifierDisplayFields(documents: CaseDoc[]) {
  return documents.map((doc) => {
    const fields = { ...doc.fields };
    let changed = false;

    const supplierGstin = normalizeGstinForDisplay(
      fields.supplierGstin,
      "supplierGstin",
    );
    if (supplierGstin && supplierGstin !== fields.supplierGstin) {
      fields.supplierGstin = supplierGstin;
      changed = true;
    }

    const buyerGstin = normalizeGstinForDisplay(
      fields.buyerGstin,
      "buyerGstin",
    );
    if (buyerGstin && buyerGstin !== fields.buyerGstin) {
      fields.buyerGstin = buyerGstin;
      changed = true;
    }

    if (
      isPurchaseOrderDocType(doc.type) &&
      fields.supplierGstin &&
      fields.buyerGstin &&
      normalizePacketValue(fields.supplierGstin, "supplierGstin") ===
        normalizePacketValue(fields.buyerGstin, "buyerGstin")
    ) {
      delete fields.supplierGstin;
      changed = true;
    }

    if (isInvoiceDocType(doc.type) && fields.invoiceNumber) {
      for (const field of PO_NUMBER_FIELD_KEYS) {
        if (
          fields[field] &&
          normalizePacketValue(fields[field], field) ===
            normalizePacketValue(fields.invoiceNumber, "invoiceNumber")
        ) {
          delete fields[field];
          changed = true;
        }
      }
    }

    const eWayBillNumber = normalizeEWayBillNumberForDisplay(
      fields.eWayBillNumber,
    );
    if (eWayBillNumber && eWayBillNumber !== fields.eWayBillNumber) {
      fields.eWayBillNumber = eWayBillNumber;
      changed = true;
    }

    for (const field of PO_NUMBER_FIELD_KEYS) {
      const reference = normalizeCompactReferenceForDisplay(fields[field]);
      if (reference && reference !== fields[field]) {
        fields[field] = reference;
        changed = true;
      }
    }

    const vehicleNumber = normalizeVehicleNumberForDisplay(
      fields.vehicleNumber,
    );
    if (vehicleNumber && vehicleNumber !== fields.vehicleNumber) {
      fields.vehicleNumber = vehicleNumber;
      changed = true;
    }

    const registrationNumber = normalizeVehicleNumberForDisplay(
      fields.registrationNumber,
    );
    if (
      registrationNumber &&
      registrationNumber !== fields.registrationNumber
    ) {
      fields.registrationNumber = registrationNumber;
      changed = true;
    }

    const lineItems = normalizeLineItemDisplayFields(
      doc.lineItems,
      doc.md ?? "",
    );
    if (lineItems !== doc.lineItems) {
      changed = true;
    }

    return changed ? { ...doc, fields, lineItems } : doc;
  });
}

function parseLooseNumber(value: string | number | null | undefined) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!value) return null;

  const compact = String(value).replace(/[₹$€£,\s]/g, "");
  const match = compact.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeWeightForDisplay(value: string | number | null | undefined) {
  const parsed = parseLooseNumber(value);
  if (parsed === null) return null;

  const raw = String(value ?? "").toLowerCase();
  const kg = /(?:m\.?t\.?s?\.?|to|metric\s*ton(?:ne)?s?|tonnes?|tons?)\b/i.test(
    raw,
  )
    ? parsed * 1000
    : parsed;
  return {
    raw: String(value ?? ""),
    kg,
  };
}

const EVIDENCE_WEIGHT_FIELDS = [
  "grossWeight",
  "tareWeight",
  "netWeight",
] as const satisfies readonly FieldKey[];
const DIGIT_WORD_VALUES: Record<string, string> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};
const DIGIT_WORD_PATTERN =
  "(?:zero|one|two|three|four|five|six|seven|eight|nine)";
const SPELLED_DIGIT_WEIGHT_PATTERN = new RegExp(
  `\\b(${DIGIT_WORD_PATTERN}(?:[\\s-]+${DIGIT_WORD_PATTERN}){2,})\\b\\s*(?:kg|kgs|kilograms?)\\b`,
  "gi",
);
const VISIBLE_WEIGHT_WITH_UNIT_PATTERN =
  /(-?\d[\d,]*(?:\.\d+)?)\s*\(?\s*(kg|kgs|kilograms?|m\.?t\.?s?\.?|to|metric\s*ton(?:ne)?s?|tonnes?|tons?)\s*\)?(?=\s|[,;:.)]|$)/gi;

function normalizeOcrWeightLetters(value: string) {
  return value.replace(/[Ττ]/g, "T").replace(/[Οο]/g, "O");
}

function normalizeWeightUnitToken(value: string) {
  const normalized = normalizeLineItemUnitForDisplay(
    normalizeOcrWeightLetters(value),
  )?.toUpperCase();
  if (normalized === "KG") return "KG" as const;
  if (normalized === "MT") return "MT" as const;
  return null;
}

function hasExplicitWeightUnit(value: string | undefined) {
  if (!value) return false;
  VISIBLE_WEIGHT_WITH_UNIT_PATTERN.lastIndex = 0;
  return VISIBLE_WEIGHT_WITH_UNIT_PATTERN.test(
    normalizeOcrWeightLetters(value),
  );
}

function findVisibleUnitForWeight(markdown: string, value: string | undefined) {
  const expected = parseLooseNumber(value);
  if (expected === null) return null;
  const normalizedMarkdown = normalizeOcrWeightLetters(markdown);

  VISIBLE_WEIGHT_WITH_UNIT_PATTERN.lastIndex = 0;
  for (const match of normalizedMarkdown.matchAll(
    VISIBLE_WEIGHT_WITH_UNIT_PATTERN,
  )) {
    const visible = parseLooseNumber(match[1]);
    const unit = normalizeWeightUnitToken(match[2]);
    if (visible !== null && unit && numbersClose(visible, expected, 0.01)) {
      return unit;
    }
  }

  const headerUnits = [
    ...normalizedMarkdown.matchAll(
      /\b(?:gross|tare|net|despatched|dispatched|received)\b[^\n]{0,80}?\(?\s*(kg|kgs|m\.?t\.?s?\.?|to|tonnes?)\s*\)?/gi,
    ),
  ]
    .map((match) => normalizeWeightUnitToken(match[1]))
    .filter((unit): unit is "KG" | "MT" => Boolean(unit));
  const uniqueHeaderUnits = [...new Set(headerUnits)];
  return uniqueHeaderUnits.length === 1 ? uniqueHeaderUnits[0] : null;
}

function differsByOneMissingDigit(current: number, candidate: number) {
  const currentDigits = String(Math.round(current));
  const candidateDigits = String(Math.round(candidate));
  if (candidateDigits.length !== currentDigits.length + 1) return false;
  return Array.from(
    { length: candidateDigits.length },
    (_, index) =>
      candidateDigits.slice(0, index) + candidateDigits.slice(index + 1),
  ).includes(currentDigits);
}

function findSpelledNetWeightKg(markdown: string, currentValue?: string) {
  const current = parseLooseNumber(currentValue);
  if (current === null) return null;

  SPELLED_DIGIT_WEIGHT_PATTERN.lastIndex = 0;
  const candidates = [...markdown.matchAll(SPELLED_DIGIT_WEIGHT_PATTERN)]
    .map((match) =>
      match[1]
        .toLowerCase()
        .split(/[\s-]+/)
        .map((word) => DIGIT_WORD_VALUES[word] ?? "")
        .join(""),
    )
    .filter(Boolean)
    .map(Number)
    .filter(
      (candidate) =>
        Number.isFinite(candidate) &&
        candidate >= 100 &&
        candidate <= 200_000 &&
        (numbersClose(candidate, current, 0.01) ||
          differsByOneMissingDigit(current, candidate)),
    );
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : null;
}

function addWeightQualityIssue(
  doc: CaseDoc,
  field: (typeof EVIDENCE_WEIGHT_FIELDS)[number],
  originalValue: string,
  reason: string,
  action: ExtractionQualityIssue["action"] = "corrected",
) {
  const qualityIssues = [...(doc.qualityIssues ?? [])];
  if (
    !qualityIssues.some(
      (issue) =>
        issue.field === field &&
        issue.originalValue === originalValue &&
        issue.action === action &&
        issue.reason === reason,
    )
  ) {
    addQualityIssue(qualityIssues, field, originalValue, action, reason);
  }
  return qualityIssues;
}

function applyVisibleWeightEvidence(doc: CaseDoc) {
  const fields = { ...doc.fields };
  let qualityIssues = doc.qualityIssues;
  let changed = false;

  for (const field of EVIDENCE_WEIGHT_FIELDS) {
    const value = fields[field];
    if (!value || hasExplicitWeightUnit(value)) continue;
    const unit = findVisibleUnitForWeight(doc.md ?? "", value);
    const parsed = parseLooseNumber(value);
    if (!unit || parsed === null) continue;
    fields[field] = `${formatNumberForField(parsed)} ${unit}`;
    qualityIssues = addWeightQualityIssue(
      { ...doc, qualityIssues },
      field,
      value,
      "Restored the weight unit from visible source text.",
    );
    changed = true;
  }

  if (doc.type === "Weighment Slip" && fields.netWeight) {
    const spelledKg = findSpelledNetWeightKg(doc.md ?? "", fields.netWeight);
    const currentKg = normalizeWeightForDisplay(fields.netWeight)?.kg ?? null;
    if (spelledKg !== null && currentKg !== null) {
      if (!numbersClose(spelledKg, currentKg, 0.01)) {
        const originalValue = fields.netWeight;
        fields.netWeight = `${formatNumberForField(spelledKg)} KG`;
        qualityIssues = addWeightQualityIssue(
          { ...doc, qualityIssues },
          "netWeight",
          originalValue,
          "Corrected a dropped OCR digit using the net weight written out in words on the weighment slip.",
        );
        changed = true;
      }
    }
  }

  return changed ? { ...doc, fields, qualityIssues } : doc;
}

function explicitShipmentWeightTargetsKg(documents: CaseDoc[]) {
  const targets: number[] = [];
  for (const doc of documents) {
    for (const field of EVIDENCE_WEIGHT_FIELDS) {
      const value = doc.fields[field];
      if (!value || !hasExplicitWeightUnit(value)) continue;
      const normalized = normalizeWeightForDisplay(value);
      if (normalized) targets.push(normalized.kg);
    }

    const fieldQuantity = parseLooseNumber(doc.fields.itemQuantity);
    const fieldUnit = normalizeWeightUnitToken(doc.fields.unit ?? "");
    if (fieldQuantity !== null && fieldUnit) {
      targets.push(fieldQuantity * (fieldUnit === "MT" ? 1000 : 1));
    }

    for (const line of doc.lineItems ?? []) {
      const quantity = parseLooseNumber(line.quantity);
      const unit = normalizeWeightUnitToken(line.unit ?? "");
      if (quantity !== null && unit) {
        targets.push(quantity * (unit === "MT" ? 1000 : 1));
      }
    }
  }
  return targets.filter((value) => value > 0 && Number.isFinite(value));
}

function enrichWeightEvidence(documents: CaseDoc[]) {
  const withVisibleEvidence = documents.map(applyVisibleWeightEvidence);
  const targets = explicitShipmentWeightTargetsKg(withVisibleEvidence);
  if (!targets.length) return withVisibleEvidence;

  return withVisibleEvidence.map((doc) => {
    const value = doc.fields.netWeight;
    if (!value || hasExplicitWeightUnit(value)) return doc;
    const parsed = parseLooseNumber(value);
    if (parsed === null) return doc;
    const matchesKg = targets.some((target) => numbersClose(target, parsed, 5));
    const matchesMt = targets.some((target) =>
      numbersClose(target, parsed * 1000, 5),
    );
    if (matchesKg === matchesMt) return doc;

    const unit = matchesMt ? "MT" : "KG";
    const fields = {
      ...doc.fields,
      netWeight: `${formatNumberForField(parsed)} ${unit}`,
    };
    const qualityIssues = addWeightQualityIssue(
      doc,
      "netWeight",
      value,
      "Restored the omitted weight unit from matching shipment evidence in the same packet.",
    );
    return { ...doc, fields, qualityIssues };
  });
}

function formatNumberForField(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2).replace(/\.?0+$/, "");
}

function numbersClose(left: number, right: number, tolerance = 0.01) {
  return Math.abs(left - right) <= Math.max(tolerance, Math.abs(right) * 0.001);
}

function isClearMagnitudeError(current: number, expected: number) {
  if (expected <= 0 || current <= 0) return false;
  if (numbersClose(current, expected)) return false;

  const ratio = current / expected;
  return [10, 100, 1000, 0.1, 0.01, 0.001].some(
    (factor) => Math.abs(ratio - factor) <= factor * 0.02,
  );
}

function normalizeTaxRateValue(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100) / 100;
  return rounded >= 0 && rounded <= 40 ? rounded : null;
}

function parseTaxRateField(value: string | number | null | undefined) {
  return normalizeTaxRateValue(parseLooseNumber(value));
}

function selectDominantTaxRate(rates: number[]) {
  const counts = new Map<string, { value: number; count: number }>();
  rates.forEach((rate) => {
    const normalized = normalizeTaxRateValue(rate);
    if (normalized === null) return;
    const key = formatNumberForField(normalized);
    const current = counts.get(key) ?? { value: normalized, count: 0 };
    current.count += 1;
    counts.set(key, current);
  });

  return (
    [...counts.values()].sort(
      (left, right) => right.count - left.count || right.value - left.value,
    )[0]?.value ?? null
  );
}

function getLineItemTaxRate(item: CommercialLineItem) {
  const taxRate = parseTaxRateField(item.taxRate);
  if (taxRate !== null) return taxRate;

  const igstRate = parseTaxRateField(item.igstRate);
  if (igstRate !== null) return igstRate;

  const cgstRate = parseTaxRateField(item.cgstRate);
  const sgstRate = parseTaxRateField(item.sgstRate);
  if (cgstRate !== null && sgstRate !== null)
    return normalizeTaxRateValue(cgstRate + sgstRate);

  return cgstRate ?? sgstRate;
}

type TaxRateFieldKey = "taxRate" | "cgstRate" | "sgstRate" | "igstRate";
type GstTaxMode = "igst" | "split" | "unknown";

const STANDARD_GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];

function inferTaxRateFromAmounts(fields: Partial<Record<FieldKey, string>>) {
  let taxableBase = parseLooseNumber(fields.subtotal);
  let taxAmount = parseLooseNumber(fields.taxAmount);
  const totalAmount = parseLooseNumber(fields.totalAmount);

  if (
    (taxAmount === null || taxAmount <= 0) &&
    taxableBase !== null &&
    totalAmount !== null &&
    totalAmount > taxableBase
  ) {
    taxAmount = totalAmount - taxableBase;
  }

  if (
    (taxableBase === null || taxableBase <= 0) &&
    taxAmount !== null &&
    totalAmount !== null &&
    totalAmount > taxAmount
  ) {
    taxableBase = totalAmount - taxAmount;
  }

  if (
    taxableBase === null ||
    taxableBase <= 0 ||
    taxAmount === null ||
    taxAmount <= 0
  )
    return null;
  return normalizeTaxRateValue((taxAmount / taxableBase) * 100);
}

function normalizeKnownGstRate(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return null;
  let closest: number | null = null;
  let closestDelta = Number.POSITIVE_INFINITY;
  for (const rate of STANDARD_GST_RATES) {
    const delta = Math.abs(rate - value);
    if (delta < closestDelta) {
      closest = rate;
      closestDelta = delta;
    }
  }
  return closestDelta <= 0.25 ? closest : null;
}

function getDominantLineItemSpecificTaxRate(
  lineItems: CommercialLineItem[] | undefined,
  field: TaxRateFieldKey,
) {
  const rates = (lineItems ?? [])
    .map((item) => parseTaxRateField(item[field]))
    .filter((value): value is number => value !== null);
  return selectDominantTaxRate(rates);
}

function getGstinStateCode(value: string | undefined) {
  const normalized = value?.toUpperCase().replace(/[^0-9A-Z]/g, "") ?? "";
  const match = normalized.match(/\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]/);
  return match?.[0].slice(0, 2) ?? null;
}

function inferTaxModeFromGstins(
  fields: Partial<Record<FieldKey, string>>,
): GstTaxMode {
  const supplierState = getGstinStateCode(fields.supplierGstin);
  const buyerState = getGstinStateCode(fields.buyerGstin);

  if (supplierState && buyerState) {
    return supplierState === buyerState ? "split" : "igst";
  }

  return "unknown"; // Both parties are needed; do not assume a company state.
}

function getLineItemTaxRateForMode(
  item: CommercialLineItem,
  taxMode: GstTaxMode,
) {
  const taxRate = parseTaxRateField(item.taxRate);
  const igstRate = parseTaxRateField(item.igstRate);
  const cgstRate = parseTaxRateField(item.cgstRate);
  const sgstRate = parseTaxRateField(item.sgstRate);
  const singleSplitRate = cgstRate ?? sgstRate;
  const taxRateLooksLikeSingleSplitComponent =
    taxRate !== null &&
    singleSplitRate !== null &&
    Math.abs(taxRate - singleSplitRate) <= 0.25;

  if (taxMode === "igst") {
    if (igstRate !== null) return igstRate;
    if (cgstRate !== null && sgstRate !== null)
      return normalizeTaxRateValue(cgstRate + sgstRate);
    if (taxRate !== null && !taxRateLooksLikeSingleSplitComponent)
      return taxRate;
    return null;
  }

  if (taxMode === "split") {
    if (cgstRate !== null && sgstRate !== null)
      return normalizeTaxRateValue(cgstRate + sgstRate);
    if (igstRate !== null) return igstRate;
    if (taxRate !== null && !taxRateLooksLikeSingleSplitComponent)
      return taxRate;
    return null;
  }

  if (taxRate !== null) return taxRate;
  return getLineItemTaxRate(item);
}

function getDominantLineItemTaxRateForMode(
  lineItems: CommercialLineItem[] | undefined,
  taxMode: GstTaxMode,
) {
  const rates = (lineItems ?? [])
    .map((item) => getLineItemTaxRateForMode(item, taxMode))
    .filter((value): value is number => value !== null);
  return selectDominantTaxRate(rates);
}

function setDocumentTaxRateField(
  fields: Partial<Record<FieldKey, string>>,
  key: TaxRateFieldKey,
  rate: number,
) {
  const formatted = formatNumberForField(rate);
  if (fields[key] === formatted) return false;
  fields[key] = formatted;
  return true;
}

function enrichDocumentTaxRateFields(doc: CaseDoc) {
  const allowedFields = new Set(getFieldKeysForDocType(doc.type));
  if (
    !(["taxRate", "cgstRate", "sgstRate", "igstRate"] as const).some((field) =>
      allowedFields.has(field),
    )
  ) {
    return doc;
  }

  const fields = { ...doc.fields };
  let changed = false;
  const taxMode = inferTaxModeFromGstins(fields);
  const lineRates = (doc.lineItems ?? [])
    .map((item) => getLineItemTaxRateForMode(item, taxMode))
    .filter((value): value is number => value !== null);
  const amountDerivedRate = inferTaxRateFromAmounts(fields);
  const totalRate =
    amountDerivedRate ??
    parseTaxRateField(fields.taxRate) ??
    getDominantLineItemTaxRateForMode(doc.lineItems, taxMode) ??
    selectDominantTaxRate(lineRates) ??
    null;

  if (taxMode !== "unknown") {
    const resolvedTotalRate =
      normalizeKnownGstRate(amountDerivedRate) ??
      normalizeKnownGstRate(parseTaxRateField(fields.taxRate)) ??
      normalizeKnownGstRate(
        getDominantLineItemTaxRateForMode(doc.lineItems, taxMode),
      ) ??
      normalizeKnownGstRate(selectDominantTaxRate(lineRates)) ??
      normalizeKnownGstRate(totalRate);
    // GSTIN state codes identify IGST versus split GST, but they do not prove
    // a percentage. Do not invent a rate without a printed or calculable rate.
    if (resolvedTotalRate === null) return doc;
    changed =
      setDocumentTaxRateField(fields, "taxRate", resolvedTotalRate) || changed;

    if (taxMode === "split") {
      changed =
        setDocumentTaxRateField(fields, "cgstRate", resolvedTotalRate / 2) ||
        changed;
      changed =
        setDocumentTaxRateField(fields, "sgstRate", resolvedTotalRate / 2) ||
        changed;
      if (fields.igstRate) {
        delete fields.igstRate;
        changed = true;
      }
    } else {
      changed =
        setDocumentTaxRateField(fields, "igstRate", resolvedTotalRate) ||
        changed;
      if (fields.cgstRate) {
        delete fields.cgstRate;
        changed = true;
      }
      if (fields.sgstRate) {
        delete fields.sgstRate;
        changed = true;
      }
    }

    return changed ? { ...doc, fields } : doc;
  }

  if (totalRate !== null && !fields.taxRate) {
    fields.taxRate = formatNumberForField(totalRate);
    changed = true;
  }

  const cgstRate =
    parseTaxRateField(fields.cgstRate) ??
    getDominantLineItemSpecificTaxRate(doc.lineItems, "cgstRate");
  const sgstRate =
    parseTaxRateField(fields.sgstRate) ??
    getDominantLineItemSpecificTaxRate(doc.lineItems, "sgstRate");
  const igstRate =
    parseTaxRateField(fields.igstRate) ??
    getDominantLineItemSpecificTaxRate(doc.lineItems, "igstRate");

  if (cgstRate !== null && !fields.cgstRate) {
    fields.cgstRate = formatNumberForField(cgstRate);
    changed = true;
  }
  if (sgstRate !== null && !fields.sgstRate) {
    fields.sgstRate = formatNumberForField(sgstRate);
    changed = true;
  }
  if (igstRate !== null && !fields.igstRate) {
    fields.igstRate = formatNumberForField(igstRate);
    changed = true;
  }

  return changed ? { ...doc, fields } : doc;
}

function parseVisibleTaxRate(value: string) {
  const normalized = value.startsWith(".") ? `0${value}` : value;
  return normalizeTaxRateValue(Number(normalized));
}

function extractPurchaseOrderTaxRatesFromText(visibleText: string) {
  const rates: number[] = [];
  const ratePattern =
    /\b(?:I\s*\/\s*)?(?:CGST|SGST|IGST|GST)\b(?:[ \t]*(?:rate)?[ \t]*)?(?:[:/-][ \t]*)?(\d{1,2}(?:\.\d+)?|\.\d+)[ \t]*%?/gi;

  visibleText.split(/\r?\n/).forEach((line) => {
    for (const match of line.matchAll(ratePattern)) {
      const rate = parseVisibleTaxRate(match[1]);
      if (rate !== null) rates.push(rate);
    }
  });

  return rates;
}

function inferPurchaseOrderTaxRate(
  doc: CaseDoc,
  lineItems: CommercialLineItem[],
) {
  if (!isPurchaseOrderDocType(doc.type)) return null;

  const lineRates = lineItems
    .map(getLineItemTaxRate)
    .filter((value): value is number => value !== null);
  const directRate = selectDominantTaxRate(lineRates);
  if (directRate !== null) return directRate;

  const visibleText = doc.md ?? "";
  const textRate = selectDominantTaxRate(
    extractPurchaseOrderTaxRatesFromText(visibleText),
  );
  if (textRate === null || textRate === 0) return textRate;

  const hasCgst = /\bcgst\b/i.test(visibleText);
  const hasSgst = /\bsgst\b/i.test(visibleText);
  const hasIgst = /\bigst\b/i.test(visibleText);
  if (hasCgst && hasSgst && !hasIgst && textRate <= 14) {
    return normalizeTaxRateValue(textRate * 2);
  }

  return textRate;
}

function fillPurchaseOrderLineItemTaxRates(
  lineItems: CommercialLineItem[],
  taxRate: number | null,
) {
  if (taxRate === null) return lineItems;

  let changed = false;
  const formattedTaxRate = formatNumberForField(taxRate);
  const next = lineItems.map((item) => {
    const amount = parseLooseNumber(item.taxableAmount ?? item.lineTotal);
    if (amount === null || amount <= 0 || item.taxRate) return item;
    changed = true;
    return { ...item, taxRate: formattedTaxRate };
  });

  return changed ? next : lineItems;
}

function correctLineItemAmounts(
  lineItems: CommercialLineItem[] | undefined,
  fields: Partial<Record<FieldKey, string>>,
) {
  if (!lineItems?.length) return lineItems;

  let changed = false;
  const documentTaxAmount = parseLooseNumber(fields.taxAmount);
  const documentTotalAmount = parseLooseNumber(fields.totalAmount);
  const corrected = lineItems.map((item) => {
    const quantity = parseLooseNumber(item.quantity);
    const rate = parseLooseNumber(item.rate ?? item.netRate);
    if (quantity === null || rate === null || quantity <= 0 || rate < 0)
      return item;

    const expected = quantity * rate;
    const next = { ...item };
    const lineTotal = parseLooseNumber(item.lineTotal);
    const taxableAmount = parseLooseNumber(item.taxableAmount);

    if (lineTotal !== null && isClearMagnitudeError(lineTotal, expected)) {
      next.lineTotal = formatNumberForField(expected);
      changed = true;
    }
    if (
      taxableAmount !== null &&
      isClearMagnitudeError(taxableAmount, expected)
    ) {
      next.taxableAmount = formatNumberForField(expected);
      changed = true;
    }

    const correctedTaxableAmount = parseLooseNumber(next.taxableAmount);
    if (
      lineItems.length === 1 &&
      lineTotal !== null &&
      correctedTaxableAmount !== null &&
      documentTaxAmount !== null &&
      documentTotalAmount !== null &&
      numbersClose(lineTotal, documentTotalAmount, 0.5) &&
      numbersClose(
        correctedTaxableAmount + documentTaxAmount,
        documentTotalAmount,
        0.5,
      )
    ) {
      next.lineTotal = formatNumberForField(correctedTaxableAmount);
      changed = true;
    }

    return next;
  });

  return changed ? corrected : lineItems;
}

function getDocumentTaxRateFromFields(
  fields: Partial<Record<FieldKey, string>>,
) {
  const explicitRate =
    parseTaxRateField(fields.taxRate) ??
    parseTaxRateField(fields.igstRate) ??
    (() => {
      const cgstRate = parseTaxRateField(fields.cgstRate);
      const sgstRate = parseTaxRateField(fields.sgstRate);
      return cgstRate !== null && sgstRate !== null
        ? normalizeTaxRateValue(cgstRate + sgstRate)
        : null;
    })();

  return normalizeKnownGstRate(explicitRate);
}

function parseInvoiceOcrMoney(value: string | undefined) {
  if (!value) return null;
  let normalized = value.replace(/[₹$€£\s]/g, "");
  if (!normalized.includes(".") && /,\d{2}$/.test(normalized)) {
    const lastComma = normalized.lastIndexOf(",");
    normalized = `${normalized.slice(0, lastComma).replace(/,/g, "")}.${normalized.slice(lastComma + 1)}`;
  } else {
    normalized = normalized.replace(/,/g, "");
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractInvoiceMaterialValueEvidence(markdown: string | undefined) {
  const visibleText = getVisibleTextFromMarkdown(markdown).replace(/\s+/g, " ");
  const material = visibleText.match(
    /\bParticulars\b[\s\S]{0,180}?\bRate\b[\s\S]{0,180}?\bMATERIAL\s+VALUE\b\s*([0-9][0-9,.]*)\s+([0-9][0-9,.]*)/i,
  );
  if (!material) return null;

  const rate = parseInvoiceOcrMoney(material[1]);
  const amount = parseInvoiceOcrMoney(material[2]);
  const freight = parseInvoiceOcrMoney(
    visibleText.match(
      /\bFREIGHT\s+VALUE\b\s*(?:Rs\.?|INR|₹)?\s*([0-9][0-9,.]*)/i,
    )?.[1],
  );
  return rate && amount ? { rate, amount, freight } : null;
}

function correctSingleInvoiceLineFromMaterialValue(doc: CaseDoc) {
  if (!isInvoiceDocType(doc.type) || doc.lineItems?.length !== 1) return doc;
  const evidence = extractInvoiceMaterialValueEvidence(doc.md);
  if (!evidence) return doc;

  const current = doc.lineItems[0];
  const quantity = parseLooseNumber(current.quantity);
  if (
    quantity === null ||
    quantity <= 0 ||
    !numbersClose(
      quantity * evidence.rate,
      evidence.amount,
      Math.max(1, evidence.amount * 0.002),
    )
  ) {
    return doc;
  }

  const subtotal = parseLooseNumber(doc.fields.subtotal);
  const freight =
    evidence.freight ?? parseLooseNumber(doc.fields.freightAmount);
  if (
    subtotal !== null &&
    freight !== null &&
    !numbersClose(
      evidence.amount + freight,
      subtotal,
      Math.max(1, subtotal * 0.002),
    )
  ) {
    return doc;
  }

  const currentAmount = parseLooseNumber(
    current.taxableAmount ?? current.lineTotal,
  );
  if (
    currentAmount !== null &&
    !numbersClose(currentAmount, evidence.amount) &&
    (subtotal === null || !numbersClose(currentAmount, subtotal))
  ) {
    return doc;
  }

  const next = {
    ...current,
    rate: current.rate ?? formatNumberForField(evidence.rate),
    taxableAmount: formatNumberForField(evidence.amount),
    lineTotal: formatNumberForField(evidence.amount),
  };
  const documentTax = parseLooseNumber(doc.fields.taxAmount);
  if (freight !== null && freight > 0 && documentTax !== null) {
    for (const field of [
      "taxAmount",
      "cgstAmount",
      "sgstAmount",
      "igstAmount",
    ] as const) {
      const amount = parseLooseNumber(next[field]);
      if (amount !== null && numbersClose(amount, documentTax)) {
        delete next[field];
      }
    }
  }

  return { ...doc, lineItems: [next] };
}

function correctInvoiceTotalMisreadAsTaxableValue(doc: CaseDoc) {
  if (!isInvoiceDocType(doc.type)) return doc;

  const fields = { ...doc.fields };
  const subtotal = parseLooseNumber(fields.subtotal);
  const totalAmount = parseLooseNumber(fields.totalAmount);
  const taxAmount = parseLooseNumber(fields.taxAmount);
  if (
    subtotal !== null ||
    totalAmount === null ||
    totalAmount <= 0 ||
    taxAmount === null ||
    taxAmount <= 0
  ) {
    return doc;
  }

  const fieldRate = getDocumentTaxRateFromFields(fields);
  const amountDerivedRate = normalizeKnownGstRate(
    (taxAmount / totalAmount) * 100,
  );
  const taxRate = fieldRate ?? amountDerivedRate;
  if (taxRate === null) return doc;

  const expectedTax = totalAmount * (taxRate / 100);
  if (!numbersClose(taxAmount, expectedTax, Math.max(1, taxAmount * 0.002))) {
    return doc;
  }

  fields.subtotal = formatNumberForField(totalAmount);
  fields.totalAmount = formatNumberForField(totalAmount + taxAmount);
  return { ...doc, fields };
}

function correctCommercialTotals(doc: CaseDoc) {
  doc = correctSingleInvoiceLineFromMaterialValue(doc);
  doc = correctInvoiceTotalMisreadAsTaxableValue(doc);
  if (!COMMERCIAL_TOTAL_DOC_TYPES.has(doc.type) || !doc.lineItems?.length)
    return doc;

  let lineItems =
    correctLineItemAmounts(doc.lineItems, doc.fields) ?? doc.lineItems;
  const lineSum = lineItems
    ?.map((item) => parseLooseNumber(item.taxableAmount ?? item.lineTotal))
    .filter((value): value is number => value !== null && value >= 0)
    .reduce((total, value) => total + value, 0);
  if (!lineSum || lineSum <= 0) {
    return lineItems === doc.lineItems ? doc : { ...doc, lineItems };
  }

  const fields = { ...doc.fields };
  let subtotal = parseLooseNumber(fields.subtotal);
  let totalAmount = parseLooseNumber(fields.totalAmount);
  let taxAmount = parseLooseNumber(fields.taxAmount);
  let changed = lineItems !== doc.lineItems;

  const hasExplicitLineTaxableAmount = lineItems.some(
    (item) => parseLooseNumber(item.taxableAmount) !== null,
  );
  if (subtotal === null && hasExplicitLineTaxableAmount) {
    subtotal = lineSum;
    fields.subtotal = formatNumberForField(lineSum);
    changed = true;
  }

  if (isPurchaseOrderDocType(doc.type)) {
    const purchaseOrderTaxRate = inferPurchaseOrderTaxRate(doc, lineItems);
    const lineItemsWithTaxRates = fillPurchaseOrderLineItemTaxRates(
      lineItems,
      purchaseOrderTaxRate,
    );
    if (lineItemsWithTaxRates !== lineItems) {
      lineItems = lineItemsWithTaxRates;
      changed = true;
    }

    if (subtotal === null) {
      subtotal = lineSum;
      fields.subtotal = formatNumberForField(lineSum);
      changed = true;
    }

    if (
      taxAmount === null &&
      subtotal !== null &&
      totalAmount !== null &&
      totalAmount >= subtotal
    ) {
      taxAmount = Math.max(0, totalAmount - subtotal);
      fields.taxAmount = formatNumberForField(taxAmount);
      changed = true;
    }

    if (
      taxAmount === null &&
      subtotal !== null &&
      purchaseOrderTaxRate !== null
    ) {
      taxAmount = subtotal * (purchaseOrderTaxRate / 100);
      fields.taxAmount = formatNumberForField(taxAmount);
      changed = true;
    }

    if (totalAmount === null && subtotal !== null && taxAmount !== null) {
      totalAmount = subtotal + taxAmount;
      fields.totalAmount = formatNumberForField(totalAmount);
      changed = true;
    }
  }

  if (subtotal !== null && isClearMagnitudeError(subtotal, lineSum)) {
    fields.subtotal = formatNumberForField(lineSum);
    changed = true;
  }

  const expectedTotal = taxAmount !== null ? lineSum + taxAmount : lineSum;
  if (
    totalAmount !== null &&
    isClearMagnitudeError(totalAmount, expectedTotal)
  ) {
    fields.totalAmount = formatNumberForField(expectedTotal);
    changed = true;
  }

  return changed ? { ...doc, fields, lineItems } : doc;
}

function enrichCommercialAmounts(documents: CaseDoc[]) {
  return enrichDocumentsWithPacketGstTaxContext(
    documents.map((doc) =>
      enrichDocumentTaxRateFields(correctCommercialTotals(doc)),
    ),
  );
}

function applyConsigneeBuyerGuardToDocuments(documents: CaseDoc[]) {
  return documents.map((doc) => {
    const fields = applyConsigneeBuyerGuard(
      doc.fields,
      getVisibleTextFromMarkdown(doc.md),
      doc.type,
    );
    return areFieldRecordsEqual(doc.fields, fields) ? doc : { ...doc, fields };
  });
}

export function enrichProcessedDocuments(documents: CaseDoc[]) {
  const sanitizedDocuments = documents.map((doc) => {
    const fields = sanitizeFieldsForDocType(doc.type, doc.fields) as Partial<
      Record<FieldKey, string>
    >;
    return areFieldRecordsEqual(doc.fields, fields) ? doc : { ...doc, fields };
  });
  const withFastag = enrichFastagContinuationDocs(sanitizedDocuments);
  const withGstin = enrichGstinConsensusValues(withFastag);
  const withPoCore = enrichPurchaseOrderCoreFields(withGstin);
  const withEWayCore = enrichEWayBillCoreFields(withPoCore);
  const withLorryCore = enrichLorryReceiptCoreFields(withEWayCore);
  const withInvoiceLogistics = enrichInvoiceLogisticsFields(withLorryCore);
  const withIrn = enrichIrnNumbers(withInvoiceLogistics);
  const withIdentifierQuality = applyIdentifierQualityGuards(withIrn);
  const withInvoiceEWay = enrichInvoiceEWayBillNumbers(withIdentifierQuality);
  const withParties = enrichEWayBillParties(withInvoiceEWay);
  const withVehicles = enrichCorroboratedVehicleNumbers(
    enrichWeighmentVehicleNumbers(withParties),
  );
  const withConsigneeGuard = applyConsigneeBuyerGuardToDocuments(withVehicles);
  const withLinkedConsensus = enrichLinkedPacketConsensus(withConsigneeGuard);
  const withWeightEvidence = enrichWeightEvidence(withLinkedConsensus);
  const enrichedDocuments = applyIdentifierQualityGuards(
    normalizeIdentifierDisplayFields(
      enrichCommercialAmounts(withWeightEvidence),
    ),
  );
  return enrichedDocuments.map((doc) => {
    const visibleText = getVisibleTextFromMarkdown(doc.md);
    const md = buildMarkdown(doc, visibleText ? [visibleText] : []);
    return md === doc.md ? doc : { ...doc, md };
  });
}

function buildProcessedVerificationResult(
  verificationResult: ReturnType<typeof verifyGroupedCaseDocuments>,
) {
  const mismatches: Mismatch[] = verificationResult.mismatches.map(
    (mismatch) => ({
      ...mismatch,
      ...buildMismatchCopy(mismatch),
    }),
  );

  return {
    verificationGroups: verificationResult.groups,
    mismatches,
  };
}

function qualityValuesEqual(
  field: FieldKey,
  left: string | undefined,
  right: string | undefined,
) {
  if (!left?.trim() || !right?.trim()) return false;
  if (field === "unit") {
    return (
      normalizeLineItemUnitForDisplay(left) ===
      normalizeLineItemUnitForDisplay(right)
    );
  }
  return (
    normalizeComparableValue(left, DEFAULT_COMPARISON_OPTIONS, field) ===
    normalizeComparableValue(right, DEFAULT_COMPARISON_OPTIONS, field)
  );
}

function getLineItemValueForField(line: CommercialLineItem, field: FieldKey) {
  switch (field) {
    case "itemDescription":
      return line.description;
    case "itemQuantity":
      return line.quantity;
    case "unit":
      return line.unit;
    case "hsnSac":
      return line.hsnSac;
    case "taxRate":
      return line.taxRate;
    case "cgstRate":
      return line.cgstRate;
    case "sgstRate":
      return line.sgstRate;
    case "igstRate":
      return line.igstRate;
    default:
      return undefined;
  }
}

function isExtractionQualityIssueResolved(
  doc: CaseDoc,
  issue: ExtractionQualityIssue,
) {
  const restoredValue = getComparableFieldValue(doc, issue.field);
  if (
    qualityValuesEqual(
      issue.field,
      restoredValue === null || restoredValue === undefined
        ? undefined
        : String(restoredValue),
      issue.originalValue,
    )
  ) {
    return true;
  }

  if (
    (doc.lineItems ?? []).some((line) =>
      qualityValuesEqual(
        issue.field,
        getLineItemValueForField(line, issue.field),
        issue.originalValue,
      ),
    )
  ) {
    return true;
  }

  return (
    doc.type === "E-Way Bill" &&
    (issue.field === "subtotal" || issue.field === "totalTaxableAmount") &&
    qualityValuesEqual(
      "totalAmount",
      doc.fields.totalAmount,
      issue.originalValue,
    )
  );
}

function buildExtractionQualityReviewMismatches(documents: CaseDoc[]) {
  const mismatches: Mismatch[] = [];
  const seen = new Set<string>();

  for (const doc of documents) {
    for (const issue of doc.qualityIssues ?? []) {
      if (
        issue.action !== "quarantined" ||
        !issue.originalValue?.trim() ||
        issue.originalValue === "<missing>"
      ) {
        continue;
      }

      if (isExtractionQualityIssueResolved(doc, issue)) continue;

      const signature = `${doc.id}:${issue.field}:${compactEvidenceValue(
        issue.originalValue,
      )}`;
      if (seen.has(signature)) continue;
      seen.add(signature);

      const sourceValue = issue.originalValue.trim();
      const values: Mismatch["values"] = [
        { docId: doc.id, value: sourceValue },
      ];
      for (const relatedDoc of documents) {
        if (relatedDoc.id === doc.id) continue;
        const relatedValue = getComparableFieldValue(relatedDoc, issue.field);
        if (
          relatedValue === null ||
          relatedValue === undefined ||
          !String(relatedValue).trim()
        ) {
          continue;
        }
        const alreadyIncluded = values.some(
          (entry) =>
            entry.docId === relatedDoc.id ||
            normalizeComparableValue(entry.value, undefined, issue.field) ===
              normalizeComparableValue(relatedValue, undefined, issue.field),
        );
        if (!alreadyIncluded) {
          values.push({ docId: relatedDoc.id, value: relatedValue });
        }
      }

      const label = FIELD_LABELS[issue.field] ?? issue.field;
      const hasCorroboratingValue = values.length > 1;
      mismatches.push({
        id: `quality-review-${doc.id}-${issue.field}-${mismatches.length + 1}`,
        field: issue.field,
        values,
        analysis:
          `${label} contains a visible source value that could not be trusted automatically: ${issue.reason}` +
          (hasCorroboratingValue
            ? " Other linked documents contain a different validated value, so this must be checked before approval."
            : " The value is preserved here for human review instead of being silently discarded."),
        fixPlan:
          `1. Open the cited source page and verify the ${label.toLowerCase()}.\n` +
          "2. Decide whether the source document is wrong, incomplete, or was read incorrectly.\n" +
          "3. Correct the source or accept the exception with supporting evidence.",
      });
    }
  }

  return mismatches;
}

function inferDocTypeFromFilename(fileName: string): DocType {
  const lower = fileName.toLowerCase();
  if (lower.includes("amended") && lower.includes("po"))
    return "Amended Purchase Order";
  if (lower.includes("test") || lower.includes("mtc") || lower.includes("mtr"))
    return "Material Test Certificate";
  if (
    lower.includes("licence") ||
    lower.includes("license") ||
    lower.includes("dl")
  )
    return "Driving Licence";
  if (
    lower.includes("permit") ||
    lower.includes("authorisation") ||
    lower.includes("authorization")
  )
    return "Transport Permit";
  if (lower.includes("photo") || lower.includes("camera"))
    return "Photo Evidence";
  if (lower.includes("tax") && lower.includes("invoice")) return "Tax Invoice";
  if (lower.includes("eway") || lower.includes("e-way")) return "E-Way Bill";
  if (lower.includes("weighment") || lower.includes("weight"))
    return "Weighment Slip";
  if (
    (lower.includes("transport") && lower.includes("challan")) ||
    lower.includes("lorry") ||
    lower.includes("consignment") ||
    lower.includes("lr")
  )
    return "Lorry Receipt";
  if (lower.includes("rc") || lower.includes("registration"))
    return "Vehicle Registration Certificate";
  if (lower.includes("pan")) return "PAN Card";
  if (lower.includes("fastag") || lower.includes("toll"))
    return "FASTag Toll Proof";
  if (lower.includes("bank") && lower.includes("statement"))
    return "Bank Statement";
  if (lower.includes("map")) return "Map Printout";
  if (lower.includes("payment") || lower.includes("sms"))
    return "Payment Screenshot";
  if (
    lower.includes("purchase-order") ||
    lower.includes("purchase_order") ||
    lower.includes("po")
  )
    return "Purchase Order";
  if (lower.includes("invoice")) return "Tax Invoice";
  if (lower.includes("receipt")) return "Receipt";
  if (
    lower.includes("delivery-note") ||
    lower.includes("delivery_note") ||
    lower.includes("delivery note")
  )
    return "Delivery Note";
  if (lower.includes("challan")) return "Delivery Challan";
  if (lower.includes("delivery")) return "Delivery Note";
  return "Unknown";
}

function normaliseDocType(raw?: string): DocType {
  if (!raw) return "Unknown";
  const value = raw.toLowerCase();
  if (value.includes("amended purchase order")) return "Amended Purchase Order";
  if (
    value.includes("material test") ||
    value.includes("test certificate") ||
    value.includes("quality certificate") ||
    value.includes("mill test")
  )
    return "Material Test Certificate";
  if (
    value.includes("driving licence") ||
    value.includes("driving license") ||
    value.includes("licence")
  )
    return "Driving Licence";
  if (
    value.includes("transport permit") ||
    value.includes("authorisation") ||
    value.includes("authorization") ||
    value.includes("permit")
  )
    return "Transport Permit";
  if (
    value.includes("photo") ||
    value.includes("camera") ||
    value.includes("loading") ||
    value.includes("unloading")
  )
    return "Photo Evidence";
  if (value.includes("tax invoice")) return "Tax Invoice";
  if (value.includes("e-way") || value.includes("eway")) return "E-Way Bill";
  if (value.includes("weighment") || value.includes("weighbridge"))
    return "Weighment Slip";
  if (
    value.includes("lorry receipt") ||
    value.includes("transport receipt") ||
    value.includes("consignment")
  )
    return "Lorry Receipt";
  if (
    value.includes("vehicle registration") ||
    value.includes("registration certificate") ||
    value.includes("rc book")
  )
    return "Vehicle Registration Certificate";
  if (value.includes("pan card") || value === "pan") return "PAN Card";
  if (value.includes("fastag") || value.includes("toll"))
    return "FASTag Toll Proof";
  if (value.includes("bank statement")) return "Bank Statement";
  if (value.includes("map")) return "Map Printout";
  if (
    value.includes("payment screenshot") ||
    value.includes("payment proof") ||
    value.includes("sms")
  )
    return "Payment Screenshot";
  if (value.includes("delivery challan") || value.includes("challan"))
    return "Delivery Challan";
  if (value.includes("delivery")) return "Delivery Note";
  if (value.includes("purchase order") || value === "po")
    return "Purchase Order";
  if (value.includes("invoice")) return "Invoice";
  if (value.includes("receipt")) return "Receipt";
  return "Unknown";
}

// Obvious, mutually exclusive headings do not need an AI round trip just to
// decide page boundaries. Ambiguous pages still use the full smart-split model.
export function inferHighConfidenceDocumentTypeFromText(
  visibleText: string,
): DocType {
  const heading = visibleText.slice(0, 900).toLowerCase();
  const matches: DocType[] = [];
  const add = (type: DocType, pattern: RegExp) => {
    if (pattern.test(heading)) matches.push(type);
  };

  add("Tax Invoice", /\btax\s+invoice\b/);
  add("Purchase Order", /\bpurchase\s+order\b/);
  add("E-Way Bill", /\be[\s-]*way\s+bill\b/);
  add("Lorry Receipt", /\blorry\s+receipt\b|\bconsignment\s+note\b/);
  add("Weighment Slip", /\bweighment\s+slip\b|\bweighbridge\s+slip\b/);
  add("Delivery Challan", /\bdelivery\s+challan\b/);
  add("Delivery Note", /\bdelivery\s+note\b/);
  add(
    "Material Test Certificate",
    /\bmaterial\s+test\s+certificate\b|\bmill\s+test\s+certificate\b/,
  );
  add("Vehicle Registration Certificate", /\bregistration\s+certificate\b/);
  add("Driving Licence", /\bdriving\s+licen[cs]e\b/);
  add("PAN Card", /\bpermanent\s+account\s+number\b|\bpan\s+card\b/);
  add("FASTag Toll Proof", /\bfastag\b.*\b(?:statement|transaction|toll)\b/);
  add("Bank Statement", /\bbank\s+statement\b/);

  return matches.length === 1 ? matches[0] : "Unknown";
}

function normalizeVisibleEvidenceText(textPages: string[]) {
  return textPages
    .join("\n")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function refineDocTypeFromVisibleText(docType: DocType, textPages: string[]) {
  if (!textPages.some((page) => page.trim())) return docType;
  const text = normalizeVisibleEvidenceText(textPages);
  const hasDeliveryChallanSignal =
    text.includes("delivery challan") ||
    text.includes("challan no") ||
    text.includes("challan number") ||
    text.includes("challan date");
  const headingText = text.slice(0, 600);
  const hasTaxInvoiceSignal =
    headingText.includes("tax invoice") ||
    text.includes("invoice no") ||
    text.includes("invoice number");

  if (
    hasTaxInvoiceSignal &&
    (docType === "Unknown" ||
      docType === "Purchase Order" ||
      docType === "Amended Purchase Order")
  ) {
    return "Tax Invoice";
  }

  if (
    hasDeliveryChallanSignal &&
    !hasTaxInvoiceSignal &&
    (docType === "Purchase Order" ||
      docType === "Amended Purchase Order" ||
      docType === "Unknown")
  ) {
    return "Delivery Challan";
  }

  return docType;
}

function retitleDocumentForType(title: string, type: DocType) {
  const label = formatDocType(type);
  const separator = " — ";
  const separatorIndex = title.indexOf(separator);
  return separatorIndex >= 0 ? `${label}${title.slice(separatorIndex)}` : title;
}

function retitleMarkdownForType(markdown: string | undefined, type: DocType) {
  if (!markdown) return markdown;
  const label = formatDocType(type);
  return markdown.replace(/^# .+?(?=\n)/, (heading) => {
    const separator = " — ";
    const separatorIndex = heading.indexOf(separator);
    return separatorIndex >= 0
      ? `# ${label}${heading.slice(separatorIndex)}`
      : `# ${label}`;
  });
}

function getMarkdownVisibleText(markdown: string | undefined) {
  if (!markdown) return "";
  const marker = "## Visible Text";
  const markerIndex = markdown.indexOf(marker);
  return markerIndex >= 0
    ? markdown.slice(markerIndex + marker.length)
    : markdown;
}

function getRefinementTextPages(doc: CaseDoc, textPages: string[]) {
  const usableTextPages = textPages.filter((page) => page.trim().length > 0);
  if (usableTextPages.length) return usableTextPages;

  const visibleText = getMarkdownVisibleText(doc.md);
  return visibleText.trim() ? [visibleText] : [];
}

function isZeroAmount(value: string | number | null | undefined) {
  const parsed = parseLooseNumber(value);
  return parsed !== null && Math.abs(parsed) === 0;
}

function removePlaceholderZeroAmountsFromLine(line: CommercialLineItem) {
  const next = { ...line };
  const hasPositiveMonetarySignal = [
    next.rate,
    next.netRate,
    next.taxableAmount,
    next.taxAmount,
    next.cgstAmount,
    next.sgstAmount,
    next.igstAmount,
  ].some((value) => {
    const parsed = parseLooseNumber(value);
    return parsed !== null && Math.abs(parsed) > 0;
  });

  if (!hasPositiveMonetarySignal) {
    if (isZeroAmount(next.lineTotal)) delete next.lineTotal;
    if (isZeroAmount(next.taxableAmount)) delete next.taxableAmount;
  }

  return next;
}

function adaptFieldsForRefinedDocType(
  fields: CaseDoc["fields"],
  previousType: DocType,
  refinedType: DocType,
) {
  const next = { ...fields };

  if (
    (refinedType === "Delivery Challan" || refinedType === "Delivery Note") &&
    (previousType === "Purchase Order" ||
      previousType === "Amended Purchase Order" ||
      previousType === "Unknown")
  ) {
    if (!next.referencePoNumber && next.poNumber) {
      next.referencePoNumber = next.poNumber;
    }
    delete next.poNumber;

    for (const key of ["subtotal", "taxAmount", "totalAmount"] as const) {
      if (isZeroAmount(next[key])) delete next[key];
    }
  }

  return next;
}

function applyVisibleDocTypeRefinement(doc: CaseDoc, textPages: string[]) {
  const refinementTextPages = getRefinementTextPages(doc, textPages);
  const refinedType = refineDocTypeFromVisibleText(
    doc.type,
    refinementTextPages,
  );
  if (refinedType === doc.type) return doc;

  const fields = adaptFieldsForRefinedDocType(
    doc.fields,
    doc.type,
    refinedType,
  );
  return {
    ...doc,
    type: refinedType,
    title: retitleDocumentForType(doc.title, refinedType),
    fields,
    lineItems: doc.lineItems?.map(removePlaceholderZeroAmountsFromLine),
    md: retitleMarkdownForType(doc.md, refinedType) ?? doc.md ?? "",
  };
}

function formatLineItemRateLabel(label: string, value?: string) {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  return `${label} ${trimmed.endsWith("%") ? trimmed : `${trimmed}%`}`;
}

function getLineItemTaxAmount(item: CommercialLineItem) {
  if (item.taxAmount) return item.taxAmount;
  if (item.igstAmount) return item.igstAmount;

  const cgstAmount = parseLooseNumber(item.cgstAmount);
  const sgstAmount = parseLooseNumber(item.sgstAmount);
  if (cgstAmount !== null && sgstAmount !== null) {
    return formatNumberForField(cgstAmount + sgstAmount);
  }

  return item.cgstAmount ?? item.sgstAmount ?? "";
}

function buildMarkdown(doc: CaseDoc, visibleTextPages: string[] = []) {
  const lines = [
    `# ${doc.title}`,
    "",
    `Source: **${doc.sourceHint ?? "uploaded"}**`,
    "",
  ];
  for (const key of getAllowedFieldKeysForDocType(doc.type)) {
    const value = doc.fields[key];
    if (value) {
      if (!lines.includes("## Extracted Fields")) {
        lines.push("## Extracted Fields", "");
      }
      lines.push(`- **${FIELD_LABELS[key]}**: ${value}`);
    }
  }

  if (doc.lineItems?.length) {
    lines.push("", "## Line Items", "");
    doc.lineItems.forEach((item, index) => {
      const label = item.lineNumber
        ? `Line ${item.lineNumber}`
        : `Line ${index + 1}`;
      const taxAmount = getLineItemTaxAmount(item);
      const parts = [
        item.itemCode,
        item.description,
        item.hsnSac ? `HSN ${item.hsnSac}` : "",
        item.quantity && item.unit
          ? `${item.quantity} ${item.unit}`
          : item.quantity,
        item.rate ? `rate ${item.rate}` : "",
        item.taxableAmount ? `taxable ${item.taxableAmount}` : "",
        formatLineItemRateLabel("GST", item.taxRate),
        formatLineItemRateLabel("CGST", item.cgstRate),
        formatLineItemRateLabel("SGST", item.sgstRate),
        formatLineItemRateLabel("IGST", item.igstRate),
        taxAmount ? `tax ${taxAmount}` : "",
        item.lineTotal ? `total ${item.lineTotal}` : "",
      ].filter(Boolean);
      lines.push(
        `- **${label}**: ${parts.join(" | ") || item.rawText || "Extracted row"}`,
      );
    });
  }

  const visibleText = visibleTextPages
    .map((text) => text.trim())
    .filter(Boolean);
  if (visibleText.length) {
    lines.push("", "## Visible Text", "");
    visibleText.forEach((text, index) => {
      if (visibleText.length > 1) {
        lines.push(`### Page ${index + 1}`, "");
      }
      lines.push(text, "");
    });
  }

  return lines.join("\n").trim();
}

function fallbackDoc(
  fileName: string,
  docType?: DocType,
  options?: { pages?: number; visibleTextPages?: string[] },
) {
  const resolvedType =
    docType && docType !== "Unknown"
      ? docType
      : inferDocTypeFromFilename(fileName);
  const fallback: CaseDoc = {
    id: `${resolvedType.toLowerCase().replace(/[^a-z0-9]+/g, "_")}-${Date.now()}`,
    type: resolvedType,
    title: `${formatDocType(resolvedType)} — ${fileName}`,
    pages: options?.pages ?? 1,
    fields: omitIgnoredFields({}) as Partial<Record<FieldKey, string>>,
    md: "",
    sourceHint: fileName,
  };
  fallback.md = buildMarkdown(fallback, options?.visibleTextPages ?? []);
  return fallback;
}

function getFileMimeType(fileName: string, mimeType: string | null) {
  if (mimeType) return mimeType;
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function bufferToDataUrl(data: Uint8Array, mimeType: string) {
  return `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function normalizeImageMimeType(mimeType: string) {
  const lower = mimeType.toLowerCase();
  if (lower === "image/jpg") return "image/jpeg";
  if (lower.startsWith("image/")) return lower;
  return "image/jpeg";
}

function isProviderSafeImageMimeType(mimeType: string) {
  return ["image/jpeg", "image/png", "image/webp"].includes(
    normalizeImageMimeType(mimeType),
  );
}

async function compressImageForProvider(input: Buffer, label: string) {
  const dimensionSteps = [
    PROVIDER_IMAGE_MAX_DIMENSION,
    2800,
    2400,
    2000,
    1600,
    1200,
  ].filter(
    (value, index, values) =>
      Number.isFinite(value) && value > 0 && values.indexOf(value) === index,
  );
  const qualitySteps = [86, 80, 74, 68, 62, 56];
  let smallest: Buffer | null = null;
  let lastError: unknown = null;

  for (const dimension of dimensionSteps) {
    for (const quality of qualitySteps) {
      try {
        const output = await sharp(input, { failOn: "none" })
          .rotate()
          .resize({
            width: dimension,
            height: dimension,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({
            quality,
            progressive: true,
            force: true,
          })
          .toBuffer();

        if (!smallest || output.byteLength < smallest.byteLength) {
          smallest = output;
        }
        if (output.byteLength <= PROVIDER_IMAGE_TARGET_BYTES) {
          return { bytes: output, mimeType: "image/jpeg" };
        }
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (smallest && smallest.byteLength <= PROVIDER_IMAGE_HARD_LIMIT_BYTES) {
    return { bytes: smallest, mimeType: "image/jpeg" };
  }

  const reason =
    lastError instanceof Error
      ? lastError.message
      : "compression did not reach a safe size";
  throw new Error(
    `Unable to prepare "${label}" for analysis. Image remains above the ${formatBytes(PROVIDER_IMAGE_HARD_LIMIT_BYTES)} provider limit after compression (${reason}).`,
  );
}

async function imageBytesToProviderDataUrl(
  data: Uint8Array,
  mimeType: string,
  label: string,
) {
  const normalizedMimeType = normalizeImageMimeType(mimeType);
  const input = Buffer.from(data);
  if (
    input.byteLength <= PROVIDER_IMAGE_TARGET_BYTES &&
    isProviderSafeImageMimeType(normalizedMimeType)
  ) {
    return bufferToDataUrl(input, normalizedMimeType);
  }

  try {
    const compressed = await compressImageForProvider(input, label);
    if (
      compressed.bytes.byteLength < input.byteLength ||
      input.byteLength > PROVIDER_IMAGE_HARD_LIMIT_BYTES
    ) {
      console.info(
        `[packet-processing] compressed image for provider: ${label} ${formatBytes(input.byteLength)} -> ${formatBytes(compressed.bytes.byteLength)}`,
      );
    }
    return bufferToDataUrl(compressed.bytes, compressed.mimeType);
  } catch (error) {
    if (
      input.byteLength <= PROVIDER_IMAGE_HARD_LIMIT_BYTES &&
      isProviderSafeImageMimeType(normalizedMimeType)
    ) {
      console.warn(
        `[packet-processing] image compression failed for ${label}; using original ${formatBytes(input.byteLength)} image. ${error instanceof Error ? error.message : String(error ?? "")}`,
      );
      return bufferToDataUrl(input, normalizedMimeType);
    }
    throw error;
  }
}

async function selectUprightPageView(params: {
  label: string;
  views: PageOrientationView[];
}) {
  const raw = await callExtractionReviewModel(
    [
      {
        role: "system",
        content:
          "Choose the correctly oriented view of one scanned document page. " +
          "Every supplied image is the same page at a different rotation. " +
          "Inspect the complete visual page, including printed text, handwriting, tables, stamps and headings. " +
          "Select the single view where the primary document reads naturally upright from top to bottom. " +
          "Do not extract fields, infer document values, or use the filename as evidence.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Select the upright view for ${params.label}.`,
          },
          ...params.views.flatMap((candidate) => [
            {
              type: "text" as const,
              text: `View ${candidate.view}`,
            },
            {
              type: "image_url" as const,
              image_url: { url: candidate.image },
            },
          ]),
        ],
      },
    ],
    {
      operation: "page-orientation-review",
      maxTokens: 2560,
      responseSchema: {
        name: "page_orientation_review",
        strict: true,
        schema: {
          type: "object",
          properties: {
            selectedView: {
              type: "string",
              enum: params.views.map((candidate) => candidate.view),
            },
          },
          required: ["selectedView"],
          additionalProperties: false,
        },
      },
    },
  );
  const parsed = JSON.parse(raw) as { selectedView?: unknown };
  if (typeof parsed.selectedView !== "string") {
    throw new Error("The page-orientation reviewer omitted its selection.");
  }
  return { selectedView: parsed.selectedView };
}

async function normalizePageImageOrientation(image: string, label: string) {
  try {
    return await orientPageImageWithVision({
      image,
      label,
      select: selectUprightPageView,
    });
  } catch (error) {
    console.warn(
      `[packet-processing] page-orientation review skipped for ${label}. ${error instanceof Error ? error.message : String(error ?? "")}`,
    );
    return image;
  }
}

async function normalizePageImageOrientations(
  images: string[],
  sourceName: string,
) {
  return mapWithConcurrency(
    images,
    Math.min(PACKET_AI_CONCURRENCY, 4),
    (image, index) =>
      normalizePageImageOrientation(image, `${sourceName} page ${index + 1}`),
  );
}

async function compactImageForAuthoritativeReview(
  image: string,
  label: string,
) {
  const separatorIndex = image.indexOf(",");
  if (
    !image.startsWith("data:image/") ||
    separatorIndex < 0 ||
    !image.slice(0, separatorIndex).includes(";base64")
  ) {
    return image;
  }

  const input = Buffer.from(image.slice(separatorIndex + 1), "base64");
  try {
    const metadata = await sharp(input, { failOn: "none" }).metadata();
    const longestEdge = Math.max(metadata.width ?? 0, metadata.height ?? 0);
    if (longestEdge > 0 && longestEdge <= REVIEW_IMAGE_MAX_DIMENSION) {
      return image;
    }

    const output = await sharp(input, { failOn: "none" })
      .rotate()
      .resize({
        width: REVIEW_IMAGE_MAX_DIMENSION,
        height: REVIEW_IMAGE_MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({
        quality: REVIEW_IMAGE_JPEG_QUALITY,
        progressive: true,
        force: true,
      })
      .toBuffer();
    console.info(
      `[packet-processing] prepared review image: ${label} ${formatBytes(input.byteLength)} -> ${formatBytes(output.byteLength)}`,
    );
    return bufferToDataUrl(output, "image/jpeg");
  } catch (error) {
    console.warn(
      `[packet-processing] review-image optimization skipped for ${label}. ${error instanceof Error ? error.message : String(error ?? "")}`,
    );
    return image;
  }
}

async function prepareAuthoritativeReviewPages(pages: ReviewSourcePage[]) {
  return mapWithConcurrency(
    pages,
    Math.min(PACKET_AI_CONCURRENCY, 4),
    async (page) => ({
      ...page,
      image: await compactImageForAuthoritativeReview(
        page.image,
        `${page.sourceFileName} page ${page.pageNumber}`,
      ),
    }),
  );
}

function hasMeaningfulTextPages(textPages: string[]) {
  return textPages.some((page) => page.replace(/\s+/g, "").length > 20);
}

async function renderPdfToImagePages(
  data: Uint8Array,
  options?: { maxPages?: number; sourceName?: string },
) {
  const sourceName = options?.sourceName || "PDF";
  const rendered = await renderPdfPages(
    data,
    options?.maxPages ?? PDF_RENDER_MAX_PAGES,
    async (bytes, page) =>
      imageBytesToProviderDataUrl(
        bytes,
        "image/png",
        sourceName + " page " + page,
      ),
  );
  return normalizePageImageOrientations(rendered, sourceName);
}

export async function renderUploadedFileForReview(params: {
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string | null;
}) {
  const mimeType = getFileMimeType(params.fileName, params.mimeType ?? null);
  if (mimeType.startsWith("image/")) {
    const image = await imageBytesToProviderDataUrl(
      params.bytes,
      mimeType,
      params.fileName,
    );
    return [
      await normalizePageImageOrientation(image, `${params.fileName} page 1`),
    ];
  }
  if (mimeType === "application/pdf") {
    return renderPdfToImagePages(params.bytes, {
      maxPages: PDF_SMART_SPLIT_MAX_PAGES,
      sourceName: params.fileName,
    });
  }
  throw new Error(
    `Unsupported document format for "${params.fileName}". Upload a PDF or image document.`,
  );
}
async function extractPdfTextPages(data: Uint8Array) {
  return pdfTextPages(data, Number(process.env.PACKET_MAX_PAGES || 40));
}

async function classifyDocumentFromImage(
  image: string,
  fileName = "",
): Promise<DocType> {
  const inferred = inferDocTypeFromFilename(fileName);
  if (!image.startsWith("data:image/")) {
    return inferred;
  }

  const raw = await callOpenRouter(
    [
      {
        role: "system",
        content:
          `Classify procurement packet pages. Return only JSON like {"documentType":"Purchase Order"} using one of: ${SUPPORTED_DOC_TYPES.join(", ")}. ` +
          "Some pages may be handwritten/manual or mixed printed and handwritten; classify by the document layout and purpose, not only by machine-readable printed text. " +
          "If the page is headed Delivery Challan or shows Challan No/Challan Date, classify it as Delivery Challan even when it references a PO No; PO No on logistics documents is only a reference.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: `Classify this file: ${fileName}` },
          { type: "image_url", image_url: { url: image } },
        ],
      },
    ],
    { expectJson: true, operation: "document-image-classification" },
  );

  const parsed = safeJsonParse<{ documentType?: string }>(raw, {});
  const classified = normaliseDocType(parsed.documentType);
  return classified === "Unknown" ? inferred : classified;
}

async function classifyDocumentFromText(
  textPages: string[],
  fileName = "",
): Promise<DocType> {
  const inferred = inferDocTypeFromFilename(fileName);
  const visibleText = textPages
    .map((page, index) => `Page ${index + 1}: ${page}`)
    .join("\n")
    .slice(0, 12000);

  if (!visibleText.trim()) {
    return inferred;
  }

  const raw = await callOpenRouter(
    [
      {
        role: "system",
        content:
          `Classify procurement packet text. Return only JSON like {"documentType":"Purchase Order"} using one of: ${SUPPORTED_DOC_TYPES.join(", ")}. ` +
          "The text may omit handwritten entries, so use file name hints and any visible labels when the embedded text is sparse. " +
          "If the text is headed Delivery Challan or shows Challan No/Challan Date, classify it as Delivery Challan even when it references a PO No; PO No on logistics documents is only a reference.",
      },
      {
        role: "user",
        content: `File name: ${fileName}\n\nVisible text:\n${visibleText}`,
      },
    ],
    { expectJson: true, operation: "document-text-classification" },
  );

  const parsed = safeJsonParse<{ documentType?: string }>(raw, {});
  const classified = normaliseDocType(parsed.documentType);
  return refineDocTypeFromVisibleText(
    classified === "Unknown" ? inferred : classified,
    textPages,
  );
}

type PdfDocumentGroup = {
  documentType: DocType;
  pageStart: number;
  pageEnd: number;
  confidence?: number;
  documentNumber?: string;
  primaryPartyName?: string;
  vehicleNumber?: string;
  splitReason?: string;
};

function pageRangeLabel(group: PdfDocumentGroup) {
  return group.pageStart === group.pageEnd
    ? `page ${group.pageStart}`
    : `pages ${group.pageStart}-${group.pageEnd}`;
}

function normalizePageNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.round(numberValue) : NaN;
}

function normalizePdfGroupIdentity(value: unknown) {
  return toText(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function readPdfGroupIdentityValue(
  record: Record<string, unknown>,
  keys: string[],
) {
  for (const key of keys) {
    const normalized = normalizePdfGroupIdentity(record[key]);
    if (normalized) return normalized;
  }
  return undefined;
}

function hasConflictingPdfGroupIdentity(left?: string, right?: string) {
  return Boolean(left && right && left !== right);
}

function shouldMergeAdjacentPdfGroups(
  previous: PdfDocumentGroup,
  current: PdfDocumentGroup,
) {
  if (
    previous.documentType !== current.documentType ||
    previous.pageEnd + 1 !== current.pageStart
  ) {
    return false;
  }

  return !(
    hasConflictingPdfGroupIdentity(
      previous.documentNumber,
      current.documentNumber,
    ) ||
    hasConflictingPdfGroupIdentity(
      previous.primaryPartyName,
      current.primaryPartyName,
    ) ||
    hasConflictingPdfGroupIdentity(
      previous.vehicleNumber,
      current.vehicleNumber,
    )
  );
}

function normalizePdfDocumentGroups(
  rawGroups: unknown,
  pageCount: number,
  fileName: string,
): PdfDocumentGroup[] {
  const inferred = inferDocTypeFromFilename(fileName);
  const groups = Array.isArray(rawGroups) ? rawGroups : [];
  const parsedGroups = groups
    .map((entry): PdfDocumentGroup | null => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const pageValues = Array.isArray(record.pages) ? record.pages : [];
      const pageStart = normalizePageNumber(
        record.pageStart ??
          record.startPage ??
          record.fromPage ??
          pageValues[0],
      );
      const pageEnd = normalizePageNumber(
        record.pageEnd ??
          record.endPage ??
          record.toPage ??
          pageValues[1] ??
          pageValues[0],
      );
      if (!Number.isFinite(pageStart) || !Number.isFinite(pageEnd)) return null;

      const group: PdfDocumentGroup = {
        documentType: normaliseDocType(
          String(record.documentType ?? record.type ?? record.docType ?? ""),
        ),
        pageStart: Math.max(1, Math.min(pageCount, pageStart)),
        pageEnd: Math.max(1, Math.min(pageCount, pageEnd)),
        documentNumber: readPdfGroupIdentityValue(record, [
          "documentNumber",
          "invoiceNumber",
          "poNumber",
          "ewayBillNumber",
          "challanNumber",
          "billNumber",
          "number",
        ]),
        primaryPartyName: readPdfGroupIdentityValue(record, [
          "primaryPartyName",
          "partyName",
          "buyerName",
          "vendorName",
          "supplierName",
          "customerName",
        ]),
        vehicleNumber: readPdfGroupIdentityValue(record, [
          "vehicleNumber",
          "lorryNumber",
          "truckNumber",
        ]),
        splitReason: toText(record.splitReason ?? record.reason) || undefined,
      };

      if (typeof record.confidence === "number") {
        group.confidence = record.confidence;
      }

      return group;
    })
    .filter((entry): entry is PdfDocumentGroup => entry !== null)
    .map((entry): PdfDocumentGroup => {
      const pageStart = Math.min(entry.pageStart, entry.pageEnd);
      const pageEnd = Math.max(entry.pageStart, entry.pageEnd);
      return { ...entry, pageStart, pageEnd };
    })
    .sort(
      (left, right) =>
        left.pageStart - right.pageStart || left.pageEnd - right.pageEnd,
    );

  if (pageCount <= 0) {
    return [];
  }

  if (!parsedGroups.length) {
    return [{ documentType: inferred, pageStart: 1, pageEnd: pageCount }];
  }

  const seen = new Set<string>();
  const normalized = parsedGroups.filter((group) => {
    const key = [
      group.documentType,
      group.pageStart,
      group.pageEnd,
      group.documentNumber ?? "",
      group.primaryPartyName ?? "",
      group.vehicleNumber ?? "",
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const isPageCovered = (pageNumber: number) =>
    normalized.some(
      (group) => group.pageStart <= pageNumber && group.pageEnd >= pageNumber,
    );

  let cursor = 1;
  while (cursor <= pageCount) {
    if (isPageCovered(cursor)) {
      cursor += 1;
      continue;
    }

    let gapEnd = cursor;
    while (gapEnd + 1 <= pageCount && !isPageCovered(gapEnd + 1)) {
      gapEnd += 1;
    }

    normalized.push({
      documentType: "Unknown",
      pageStart: cursor,
      pageEnd: gapEnd,
    });
    cursor = gapEnd + 1;
  }

  normalized.sort(
    (left, right) =>
      left.pageStart - right.pageStart || left.pageEnd - right.pageEnd,
  );

  return normalized.length
    ? normalized
    : [{ documentType: inferred, pageStart: 1, pageEnd: pageCount }];
}

function isCollapsedPdfSplit(groups: PdfDocumentGroup[], pageCount: number) {
  return (
    pageCount > 1 &&
    groups.length === 1 &&
    groups[0]?.pageStart === 1 &&
    groups[0]?.pageEnd === pageCount
  );
}

function compactConsecutivePdfGroups(groups: PdfDocumentGroup[]) {
  const sorted = [...groups].sort(
    (left, right) =>
      left.pageStart - right.pageStart || left.pageEnd - right.pageEnd,
  );
  const compacted: PdfDocumentGroup[] = [];

  for (const group of sorted) {
    const previous = compacted[compacted.length - 1];
    if (previous && shouldMergeAdjacentPdfGroups(previous, group)) {
      previous.pageEnd = group.pageEnd;
      previous.confidence =
        typeof previous.confidence === "number" &&
        typeof group.confidence === "number"
          ? Math.min(previous.confidence, group.confidence)
          : (previous.confidence ?? group.confidence);
      previous.documentNumber = previous.documentNumber ?? group.documentNumber;
      previous.primaryPartyName =
        previous.primaryPartyName ?? group.primaryPartyName;
      previous.vehicleNumber = previous.vehicleNumber ?? group.vehicleNumber;
      previous.splitReason = previous.splitReason ?? group.splitReason;
      continue;
    }

    compacted.push({ ...group });
  }

  return compacted;
}

async function splitPdfPagesIndividually(params: {
  fileName: string;
  textPages: string[];
  pageImages: string[];
  pageCount: number;
}) {
  const systemPrompt =
    `Classify one page from a procurement packet PDF. Return only JSON with a top-level "documents" array. ` +
    `Each item must contain documentType and confidence. Also include documentNumber, primaryPartyName, vehicleNumber, and splitReason when visible. ` +
    `Use only these documentType values: ${SUPPORTED_DOC_TYPES.join(", ")}. ` +
    `Use the rendered page image as the source of truth when available; use text only as supporting context. ` +
    `If this one page visibly contains multiple separate documents or cards, return multiple records. ` +
    `If a page contains a separate invoice, identify that invoice by visible invoice number and party/customer/supplier name. ` +
    `Do not infer document type from the file name when the page image/text shows a different document. ` +
    `A page headed Delivery Challan or showing Challan No/Challan Date is Delivery Challan even if it contains PO No as a reference.`;

  const pageGroups = await mapWithConcurrency(
    Array.from({ length: params.pageCount }, (_, index) => index),
    PACKET_AI_CONCURRENCY,
    async (index) => {
      const pageNumber = index + 1;
      const pageText = params.textPages[index] || "[No text extracted]";
      const pageImage = params.pageImages[index];

      const raw = pageImage
        ? await callOpenRouter(
            [
              {
                role: "system",
                content: systemPrompt,
              },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text:
                      `File name: ${params.fileName}. Classify rendered page ${pageNumber} of ${params.pageCount}.\n\n` +
                      `OCR text for this page:\n${pageText.slice(0, 8000)}`,
                  },
                  { type: "image_url" as const, image_url: { url: pageImage } },
                ],
              },
            ],
            {
              expectJson: true,
              model: getQualityExtractionModel(),
              reasoning: getSplitClassificationReasoning(),
              maxTokens: PACKET_SPLIT_MAX_OUTPUT_TOKENS,
              operation: "pdf-page-classification",
            },
          )
        : await callOpenRouter(
            [
              {
                role: "system",
                content: systemPrompt,
              },
              {
                role: "user",
                content:
                  `File name: ${params.fileName}. Classify page ${pageNumber} of ${params.pageCount}.\n\n` +
                  `Visible text:\n${pageText.slice(0, 12000)}`,
              },
            ],
            {
              expectJson: true,
              model: getQualityExtractionModel(),
              reasoning: getSplitClassificationReasoning(),
              maxTokens: PACKET_SPLIT_MAX_OUTPUT_TOKENS,
              operation: "pdf-page-classification",
            },
          );

      const parsed = safeJsonParse<{ documents?: unknown }>(raw, {});
      const pageDocuments = Array.isArray(parsed.documents)
        ? parsed.documents
        : [];
      const normalizedPageGroups = normalizePdfDocumentGroups(
        pageDocuments.map((entry) =>
          entry && typeof entry === "object"
            ? {
                ...(entry as Record<string, unknown>),
                pageStart: pageNumber,
                pageEnd: pageNumber,
              }
            : entry,
        ),
        params.pageCount,
        params.fileName,
      )
        .map((group) => ({
          ...group,
          documentType: refineDocTypeFromVisibleText(group.documentType, [
            params.textPages[pageNumber - 1] ?? "",
          ]),
        }))
        .filter(
          (group) =>
            group.pageStart === pageNumber && group.pageEnd === pageNumber,
        );

      return normalizedPageGroups.length
        ? normalizedPageGroups
        : [
            {
              documentType: "Unknown" as DocType,
              pageStart: pageNumber,
              pageEnd: pageNumber,
            },
          ];
    },
  );

  return compactConsecutivePdfGroups(pageGroups.flat());
}

async function splitPdfIntoDocumentGroups(params: {
  fileName: string;
  textPages: string[];
  pageImages: string[];
  loadPageImages?: () => Promise<string[]>;
}) {
  const pageCount = Math.max(params.textPages.length, params.pageImages.length);
  if (pageCount <= 1) {
    return [
      {
        documentType: params.textPages.some((page) => page.trim())
          ? await classifyDocumentFromText(params.textPages, params.fileName)
          : await classifyDocumentFromImage(
              params.pageImages[0] ?? "",
              params.fileName,
            ),
        pageStart: 1,
        pageEnd: 1,
      },
    ];
  }

  const obviousPageTypes = params.textPages.map(
    inferHighConfidenceDocumentTypeFromText,
  );
  if (
    obviousPageTypes.length === pageCount &&
    obviousPageTypes.every((type) => type !== "Unknown") &&
    new Set(obviousPageTypes).size === obviousPageTypes.length
  ) {
    return obviousPageTypes.map((documentType, index) => ({
      documentType,
      pageStart: index + 1,
      pageEnd: index + 1,
      confidence: 0.99,
      splitReason: "Distinct document heading found in embedded PDF text.",
    }));
  }

  const hasText = hasMeaningfulTextPages(params.textPages);
  const systemPrompt =
    `You split uploaded procurement packet PDFs into separate documents. Return only JSON with a top-level "documents" array. ` +
    `Each item must contain documentType, pageStart, pageEnd, and confidence. Also include documentNumber, primaryPartyName, vehicleNumber, and splitReason when visible. ` +
    `Use only these documentType values: ${SUPPORTED_DOC_TYPES.join(", ")}. ` +
    `Group consecutive pages belonging to the same physical/logical document. Do not merge different document types just because they are in one PDF. ` +
    `Do not merge separate documents just because they have the same documentType. Split same-type documents when invoice number, bill number, PO number, party/customer/supplier name, GSTIN, vehicle number, page numbering, letterhead, total section, or document heading resets or changes. ` +
    `A single uploaded PDF can contain two or more invoices for the same vehicle but different parties; emit each invoice as its own Invoice document with its own page range and party identity. ` +
    `If one scanned page visibly contains multiple separate cards/documents, output multiple records with the same pageStart and pageEnd. ` +
    `For example, one page may contain Vehicle Registration Certificate, Driving Licence, and PAN Card together; emit three records all pointing to that page. ` +
    `Do not invent PAN Card or Driving Licence records on later pages just because they appeared on an earlier multi-document scan. ` +
    `Pages showing camera overlays, vehicle loading/unloading photos, gate photos, or timestamped vehicle photos are Photo Evidence. ` +
    `Use PAN Card only when the page visibly contains Income Tax/Permanent Account Number/PAN card content. Use Driving Licence only when the page visibly contains a licence card. ` +
    `A page headed Delivery Challan or showing Challan No/Challan Date is Delivery Challan even if it contains PO No as a reference.`;

  const pageTextSummary = params.textPages
    .map(
      (page, index) =>
        `Page ${index + 1} text:\n${page || "[No text extracted]"}`,
    )
    .join("\n\n")
    .slice(0, 30000);

  if (!params.pageImages.length && !hasText) {
    return [
      {
        documentType: inferDocTypeFromFilename(params.fileName),
        pageStart: 1,
        pageEnd: pageCount,
      },
    ];
  }

  const raw = hasText
    ? await callOpenRouter(
        [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content:
              `File name: ${params.fileName}\n` +
              `There are ${params.textPages.length} pages. Identify which document is on which pages.\n\n` +
              pageTextSummary,
          },
        ],
        {
          expectJson: true,
          model: getQualityExtractionModel(),
          reasoning: getSplitClassificationReasoning(),
          maxTokens: PACKET_SPLIT_MAX_OUTPUT_TOKENS,
          operation: "pdf-smart-split",
        },
      )
    : params.pageImages.length
      ? await callOpenRouter(
          [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    `File name: ${params.fileName}. There are ${pageCount} pages. Identify which document is on which pages. ` +
                    `Use the rendered page images as the source of truth; use the OCR text only as supporting context.\n\n${pageTextSummary}`,
                },
                ...params.pageImages.flatMap((image, index) => [
                  { type: "text" as const, text: `Rendered page ${index + 1}` },
                  { type: "image_url" as const, image_url: { url: image } },
                ]),
              ],
            },
          ],
          {
            expectJson: true,
            model: getQualityExtractionModel(),
            reasoning: getSplitClassificationReasoning(),
            maxTokens: PACKET_SPLIT_MAX_OUTPUT_TOKENS,
            operation: "pdf-smart-split",
          },
        )
      : await callOpenRouter(
          [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `File name: ${params.fileName}. There are ${params.pageImages.length} rendered pages. Identify which document is on which pages.`,
                },
                ...params.pageImages.flatMap((image, index) => [
                  { type: "text" as const, text: `Page ${index + 1}` },
                  { type: "image_url" as const, image_url: { url: image } },
                ]),
              ],
            },
          ],
          {
            expectJson: true,
            reasoning: getSplitClassificationReasoning(),
            maxTokens: PACKET_SPLIT_MAX_OUTPUT_TOKENS,
            operation: "pdf-smart-split",
          },
        );

  const parsed = safeJsonParse<{ documents?: unknown; groups?: unknown }>(
    raw,
    {},
  );
  const normalized = normalizePdfDocumentGroups(
    parsed.documents ?? parsed.groups,
    pageCount,
    params.fileName,
  ).map((group) => ({
    ...group,
    documentType: refineDocTypeFromVisibleText(
      group.documentType,
      params.textPages.slice(group.pageStart - 1, group.pageEnd),
    ),
  }));

  if (isCollapsedPdfSplit(normalized, pageCount)) {
    try {
      const pageImages = params.pageImages.length
        ? params.pageImages
        : ((await params.loadPageImages?.()) ?? []);
      const pageLevelGroups = await splitPdfPagesIndividually({
        ...params,
        pageImages,
        pageCount,
      });
      if (
        pageLevelGroups.length > 1 ||
        (pageLevelGroups.length === 1 &&
          pageLevelGroups[0]?.documentType !== normalized[0]?.documentType)
      ) {
        return pageLevelGroups;
      }
    } catch (error) {
      console.warn("Page-level smart split fallback failed", error);
    }
  }

  return normalized;
}

async function extractPdfDocumentGroups(params: {
  fileName: string;
  textPages: string[];
  pageImages: string[];
  loadPageImages?: () => Promise<string[]>;
  groups: PdfDocumentGroup[];
  onGroupProgress?: (details: {
    current: number;
    total: number;
    group: PdfDocumentGroup;
  }) => Promise<void> | void;
}) {
  const hasText = hasMeaningfulTextPages(params.textPages);

  return mapWithConcurrency(
    params.groups,
    PACKET_AI_CONCURRENCY,
    async (group, index) => {
      await params.onGroupProgress?.({
        current: index + 1,
        total: params.groups.length,
        group,
      });

      const pageStartIndex = group.pageStart - 1;
      const pageEndIndex = group.pageEnd;
      const sourceHint = `${params.fileName} (${pageRangeLabel(group)})`;
      const groupFileName = sourceHint;
      const groupTextPages = params.textPages.slice(
        pageStartIndex,
        pageEndIndex,
      );
      let groupPageImages = params.pageImages.slice(
        pageStartIndex,
        pageEndIndex,
      );
      const hasGroupText = groupTextPages.some(
        (page) => page.replace(/\s+/g, "").length > 20,
      );

      let document =
        hasText && hasGroupText
          ? await extractDataFromTextPages({
              fileName: groupFileName,
              textPages: groupTextPages,
              documentType: group.documentType,
            })
          : groupPageImages.length
            ? await extractDataFromImagePages({
                fileName: groupFileName,
                pageImages: groupPageImages,
                documentType: group.documentType,
              })
            : fallbackDoc(groupFileName, group.documentType, {
                pages: Math.max(1, group.pageEnd - group.pageStart + 1),
                visibleTextPages: groupTextPages,
              });

      const needsQualityRetry = hasGroupText
        ? needsImageFallbackForTextExtraction(document)
        : isWeakExtraction(document);
      if (needsQualityRetry && group.documentType !== "Unknown") {
        if (!groupPageImages.length && params.loadPageImages) {
          const loadedPageImages = await params.loadPageImages();
          groupPageImages = loadedPageImages.slice(
            pageStartIndex,
            pageEndIndex,
          );
        }
        const qualityModel = getQualityExtractionModel();
        const qualityReasoning = getQualityExtractionReasoning();
        const retryDocument = groupPageImages.length
          ? await extractDataFromImagePages({
              fileName: groupFileName,
              pageImages: groupPageImages,
              documentType: group.documentType,
              model: qualityModel,
              reasoning: qualityReasoning,
              qualityRetry: true,
            })
          : hasText && groupTextPages.some((page) => page.trim())
            ? await extractDataFromTextPages({
                fileName: groupFileName,
                textPages: groupTextPages,
                documentType: group.documentType,
                model: qualityModel,
                reasoning: qualityReasoning,
                qualityRetry: true,
              })
            : null;

        if (retryDocument && !isWeakExtraction(retryDocument)) {
          document = mergeExtractedDocs(retryDocument, document);
        } else if (retryDocument) {
          document = mergeExtractedDocs(document, retryDocument);
        }
      }

      document = applyVisibleDocTypeRefinement(document, groupTextPages);
      document.sourceHint = sourceHint;
      document.sourceFileName = params.fileName;
      document.sourcePageNumbers = Array.from(
        { length: group.pageEnd - group.pageStart + 1 },
        (_, offset) => group.pageStart + offset,
      );
      document.pages = Math.max(1, group.pageEnd - group.pageStart + 1);
      return document;
    },
  );
}

async function extractDataFromImagePages(params: {
  fileName: string;
  pageImages: string[];
  documentType: DocType;
  model?: string;
  reasoning?: ReturnType<typeof getQualityExtractionReasoning>;
  qualityRetry?: boolean;
}) {
  const allowedFieldKeys = getAllowedFieldKeysForDocType(params.documentType);
  const allowedFieldKeysText = allowedFieldKeys.join(", ");
  const lineItemInstruction = getLineItemExtractionInstruction(
    params.documentType,
  );
  const documentSpecificInstruction = getDocumentSpecificExtractionInstruction(
    params.documentType,
  );
  const qualityInstruction = params.qualityRetry
    ? "This is a quality retry because the first extraction was incomplete. Re-read the page carefully, including every visible commercial item row, handwritten/manual entries, small text, IDs, stamps, QR-adjacent text, and rotated/cropped regions. If the document has an item table, return each goods or service row in lineItems with its visible description, HSN/SAC, quantity, unit, rate, taxable amount, and tax values. Do not return empty fields when any requested value is visible. "
    : "";

  const extracted = await mapWithConcurrency(
    params.pageImages,
    PACKET_AI_CONCURRENCY,
    async (image, index) => {
      const raw = await callOpenRouter(
        [
          {
            role: "system",
            content:
              `Extract structured fields and visible text from procurement, logistics, transport, vehicle KYC, FASTag, quality certificate, and photo-evidence documents and return only JSON with keys "fields", "lineItems", and "visibleText". ` +
              `This document is a ${params.documentType}. Use only these field keys for this document type: ${allowedFieldKeysText}. ` +
              "visibleText must be a raw OCR-style transcription of the important visible text on the page. " +
              IMAGE_HANDWRITTEN_EXTRACTION_INSTRUCTION +
              AMOUNT_EXTRACTION_INSTRUCTION +
              CONSIGNEE_EXTRACTION_INSTRUCTION +
              DELIVERY_REFERENCE_EXTRACTION_INSTRUCTION +
              DOCUMENT_SOURCE_BOUNDARY_INSTRUCTION +
              qualityInstruction +
              documentSpecificInstruction +
              lineItemInstruction +
              STAMP_SIGNATURE_EXTRACTION_INSTRUCTION +
              "For FASTag Toll Proof documents, extract statement reference, customer ID/name, statement period/date, vehicle number, tag account number, trip count, opening/credit/debit/closing balances, recharge/payment amount, toll plaza, and a compact toll transaction summary using the canonical FASTag keys. " +
              "For seller-issued documents, vendorName is the issuing supplier/seller/consignor and buyerName is the receiving buyer, keeping a separate consignee/ship-to/recipient distinct from the billed buyer. " +
              "For Purchase Order or Amended Purchase Order documents, vendorName is the supplier/vendor receiving the order and buyerName is the purchaser issuing the order.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  `Extract only clearly visible ${params.documentType} fields from ${params.fileName}. ` +
                  "Treat printed and handwritten entries equally when they are readable.",
              },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
        {
          expectJson: true,
          model: params.model,
          reasoning: params.reasoning,
          operation: params.qualityRetry
            ? "page-image-extraction-retry"
            : "page-image-extraction",
        },
      );

      const parsed = safeJsonParse<{
        fields?: Record<string, unknown>;
        lineItems?: unknown;
        visibleText?: unknown;
        text?: unknown;
        ocrText?: unknown;
      }>(raw, {});
      return {
        fields: parsed.fields ?? {},
        lineItems: sanitizeLineItems(parsed.lineItems).map((item) => ({
          ...item,
          sourcePage: item.sourcePage ?? index + 1,
        })),
        visibleText:
          toText(parsed.visibleText) ||
          toText(parsed.ocrText) ||
          toText(parsed.text),
      };
    },
  );

  const combinedFields = extracted.reduce(
    (acc, current) => ({ ...acc, ...current.fields }),
    {},
  );
  const visibleTextPages = extracted
    .map((page) => page.visibleText)
    .filter(Boolean);
  const visibleText = visibleTextPages.join("\n");
  const mappedFields = mapFields(combinedFields, params.documentType);
  const lineItems = normalizeExtractedCommercialLineItems({
    docType: params.documentType,
    lineItems: extracted.flatMap((page) => page.lineItems),
    visibleTextPages,
    documentFields: mappedFields,
  });
  const fields = applyPoNumberLabelGuard(
    applyVisibleStoreEvidenceFallback(
      applyInvoicePoReferenceFallback(
        applyPhotoEvidenceVehicleVisibilityCopy(
          applyFastagDetailsFallback(
            applyEWayBillAddressFallback(
              applyConsigneeBuyerGuard(
                applyPurchaseOrderTermsFallback(
                  applyPurchaseOrderDateFallback(
                    applyInvoiceCommercialFieldFallback(
                      mappedFields,
                      params.documentType,
                      visibleText,
                    ),
                    params.documentType,
                    visibleText,
                  ),
                  params.documentType,
                  visibleText,
                ),
                visibleText,
                params.documentType,
              ),
              params.documentType,
              visibleText,
            ),
            params.documentType,
            visibleText,
          ),
          params.documentType,
        ),
        params.documentType,
        visibleText,
      ),
      params.documentType,
      visibleText,
    ),
    visibleText,
  );

  let doc: CaseDoc = {
    id: `${params.fileName}-${Date.now()}`,
    type: params.documentType,
    title: `${formatDocType(params.documentType)} — ${params.fileName}`,
    pages: params.pageImages.length,
    fields,
    lineItems,
    md: "",
    sourceHint: params.fileName,
    sourceFileName: params.fileName,
  };
  doc = applyVisibleDocTypeRefinement(doc, visibleTextPages);
  doc.md = buildMarkdown(doc, visibleTextPages);
  return doc;
}

async function extractDataFromTextPages(params: {
  fileName: string;
  textPages: string[];
  documentType: DocType;
  model?: string;
  reasoning?: ReturnType<typeof getQualityExtractionReasoning>;
  qualityRetry?: boolean;
}) {
  const allowedFieldKeys = getAllowedFieldKeysForDocType(params.documentType);
  const allowedFieldKeysText = allowedFieldKeys.join(", ");
  const lineItemInstruction = getLineItemExtractionInstruction(
    params.documentType,
  );
  const documentSpecificInstruction = getDocumentSpecificExtractionInstruction(
    params.documentType,
  );
  const qualityInstruction = params.qualityRetry
    ? "This is a quality retry because the first extraction was incomplete. Re-read the text carefully, capture every visible commercial item row in lineItems, and do not return empty fields when any requested value is visible. "
    : "";
  const visibleText = params.textPages
    .map((page, index) => `Page ${index + 1}: ${page}`)
    .join("\n\n");

  if (!visibleText.trim()) {
    return fallbackDoc(params.fileName, params.documentType, {
      pages: Math.max(1, params.textPages.length),
    });
  }

  const raw = await callOpenRouter(
    [
      {
        role: "system",
        content:
          `Extract structured fields from procurement packet text and return only JSON with keys "fields", "lineItems", and "visibleText". ` +
          `This document is a ${params.documentType}. Use only these field keys for this document type: ${allowedFieldKeysText}. ` +
          TEXT_HANDWRITTEN_EXTRACTION_INSTRUCTION +
          AMOUNT_EXTRACTION_INSTRUCTION +
          CONSIGNEE_EXTRACTION_INSTRUCTION +
          DELIVERY_REFERENCE_EXTRACTION_INSTRUCTION +
          DOCUMENT_SOURCE_BOUNDARY_INSTRUCTION +
          qualityInstruction +
          documentSpecificInstruction +
          lineItemInstruction +
          STAMP_SIGNATURE_EXTRACTION_INSTRUCTION +
          "Use only information present in the visible text. For seller-issued documents, vendorName is the issuing supplier and buyerName is the receiving buyer, keeping a separate consignee/ship-to/recipient distinct from the billed buyer. " +
          "For Purchase Order or Amended Purchase Order documents, vendorName is the supplier/vendor receiving the order and buyerName is the purchaser issuing the order.",
      },
      {
        role: "user",
        content: `File name: ${params.fileName}\n\nVisible text:\n${visibleText.slice(0, 24000)}`,
      },
    ],
    {
      expectJson: true,
      model: params.model,
      reasoning: params.reasoning,
      operation: params.qualityRetry
        ? "document-text-extraction-retry"
        : "document-text-extraction",
    },
  );

  const parsed = safeJsonParse<{
    fields?: Record<string, unknown>;
    lineItems?: unknown;
    visibleText?: unknown;
  }>(raw, {});
  const mappedFields = mapFields(parsed.fields ?? {}, params.documentType);
  const fields = applyPoNumberLabelGuard(
    applyVisibleStoreEvidenceFallback(
      applyInvoicePoReferenceFallback(
        applyPhotoEvidenceVehicleVisibilityCopy(
          applyFastagDetailsFallback(
            applyEWayBillAddressFallback(
              applyConsigneeBuyerGuard(
                applyPurchaseOrderTermsFallback(
                  applyPurchaseOrderDateFallback(
                    applyInvoiceCommercialFieldFallback(
                      mappedFields,
                      params.documentType,
                      visibleText,
                    ),
                    params.documentType,
                    visibleText,
                  ),
                  params.documentType,
                  visibleText,
                ),
                visibleText,
                params.documentType,
              ),
              params.documentType,
              visibleText,
            ),
            params.documentType,
            visibleText,
          ),
          params.documentType,
        ),
        params.documentType,
        visibleText,
      ),
      params.documentType,
      visibleText,
    ),
    visibleText,
  );
  const visibleTextPages = params.textPages;
  const lineItems = normalizeExtractedCommercialLineItems({
    docType: params.documentType,
    lineItems: sanitizeLineItems(parsed.lineItems),
    visibleTextPages,
    documentFields: mappedFields,
  });

  let doc: CaseDoc = {
    id: `${params.fileName}-${Date.now()}`,
    type: params.documentType,
    title: `${formatDocType(params.documentType)} — ${params.fileName}`,
    pages: Math.max(1, params.textPages.length),
    fields,
    lineItems,
    md: "",
    sourceHint: params.fileName,
    sourceFileName: params.fileName,
  };
  doc = applyVisibleDocTypeRefinement(doc, params.textPages);
  doc.md = buildMarkdown(doc, params.textPages);
  return doc;
}

async function retryWeakImageExtraction(params: {
  document: CaseDoc;
  fileName: string;
  pageImages: string[];
  documentType: DocType;
}) {
  if (
    !params.pageImages.length ||
    params.documentType === "Unknown" ||
    !isWeakExtraction(params.document)
  ) {
    return params.document;
  }

  const retryDocument = await extractDataFromImagePages({
    fileName: params.fileName,
    pageImages: params.pageImages,
    documentType: params.documentType,
    model: getQualityExtractionModel(),
    reasoning: getQualityExtractionReasoning(),
    qualityRetry: true,
  });

  return !isWeakExtraction(retryDocument)
    ? mergeExtractedDocs(retryDocument, params.document)
    : mergeExtractedDocs(params.document, retryDocument);
}

function buildMismatchCopy(
  mismatch: Omit<Mismatch, "analysis" | "fixPlan">,
): Pick<Mismatch, "analysis" | "fixPlan"> {
  const lineItemLabels: Record<string, string> = {
    "lineItems.unmatchedDocumentLine": "Document line item",
    "lineItems.unmatchedInvoiceLine": "Invoice line item",
    "lineItems.uninvoicedPoLine": "PO line item",
    "lineItems.quantityExceeded": "Line item quantity",
    "lineItems.quantityMismatch": "Line item quantity",
    "lineItems.rateMismatch": "Line item rate",
    "lineItems.unitMismatch": "Line item unit",
    "lineItems.hsnSacMismatch": "Line item HSN/SAC",
    "lineItems.amountMismatch": "Line item amount",
  };
  const label =
    lineItemLabels[mismatch.field] ??
    FIELD_LABELS[mismatch.field as FieldKey] ??
    mismatch.field;

  if (mismatch.field === WEIGHT_CALCULATION_FIELD) {
    const calculation = String(mismatch.values[0]?.value ?? "").trim();
    return {
      analysis:
        calculation ||
        "Gross Weight minus Tare Weight does not equal the printed Net Weight.",
      fixPlan:
        "1. Verify the gross, tare, and net weights on the source slip.\n" +
        "2. Replace or correct the slip if its printed calculation is wrong.\n" +
        "3. Run analysis again before approving the case.",
    };
  }

  if (mismatch.field === "lorryReceiptNumber") {
    const counts = new Map<string, { value: string; count: number }>();
    for (const entry of mismatch.values) {
      const normalized = normalizePacketValue(
        entry.value,
        "lorryReceiptNumber",
      );
      if (!normalized) continue;
      const current = counts.get(normalized) ?? {
        value: String(entry.value),
        count: 0,
      };
      current.count += 1;
      counts.set(normalized, current);
    }
    const ranked = [...counts.values()].sort(
      (left, right) => right.count - left.count,
    );
    if (ranked[0]?.count >= 2 && ranked.length >= 2) {
      const outliers = ranked
        .slice(1)
        .map((entry) => entry.value)
        .join(", ");
      return {
        analysis:
          `${label} ${ranked[0].value} is corroborated by ${ranked[0].count} linked documents, while ${outliers} appears on another logistics document. ` +
          "This may be a secondary carrier consignment reference, but it must be confirmed before approval.",
        fixPlan:
          "1. Check whether the different number is a secondary carrier or subcontractor consignment note.\n" +
          "2. If both references are legitimate, record the explanation and resolve the review item.\n" +
          "3. If they should match, correct or replace the inconsistent document and run analysis again.",
      };
    }
  }

  if (WEIGHT_MISMATCH_FIELDS.has(mismatch.field as FieldKey)) {
    const normalizedWeights = mismatch.values
      .map((entry) => normalizeWeightForDisplay(entry.value))
      .filter((value): value is { raw: string; kg: number } => Boolean(value));

    if (normalizedWeights.length >= 2) {
      const [first, second] = normalizedWeights;
      const difference = Math.abs(first.kg - second.kg);
      return {
        analysis:
          `${label} differs after unit normalization: ${first.raw} = ${formatNumberForField(first.kg)} kg, ` +
          `${second.raw} = ${formatNumberForField(second.kg)} kg. Difference: ${formatNumberForField(difference)} kg.`,
        fixPlan:
          `1. Confirm the correct ${label.toLowerCase()} from the source document.\n` +
          "2. If one document is rounded, verify the allowed tolerance with operations.\n" +
          "3. Correct or replace the inconsistent file, then run analysis again.",
      };
    }
  }

  return {
    analysis: `${label} does not reconcile across the uploaded documents. Review the packet before approval.`,
    fixPlan: `1. Confirm the correct ${label.toLowerCase()} from the source document.\n2. Correct or replace the inconsistent file.\n3. Run analysis again before accepting the case.`,
  };
}

export function verifyProcessedDocuments(
  documents: CaseDoc[],
  comparisonOptions: ReturnType<typeof readComparisonOptions>,
) {
  const enrichedDocuments = enrichProcessedDocuments(
    collapseDuplicateInvoiceCopies(documents),
  );
  const verificationResult = verifyGroupedCaseDocuments(
    enrichedDocuments,
    comparisonOptions,
  );
  const verified = buildProcessedVerificationResult(verificationResult);
  return {
    ...verified,
    mismatches: [
      ...verified.mismatches,
      ...buildExtractionQualityReviewMismatches(enrichedDocuments),
    ],
  };
}

export function verifyWeightCalculationIntegrity(documents: CaseDoc[]) {
  return verifyWeightCalculationInvariants(documents).map((mismatch) => ({
    ...mismatch,
    ...buildMismatchCopy(mismatch),
  }));
}

export async function extractPdfPacketDocuments(params: {
  bytes: Uint8Array;
  fileName: string;
  textPages: string[];
  onGroupProgress?: (details: {
    current: number;
    total: number;
    documentType: DocType;
  }) => Promise<void> | void;
}) {
  let pageImages: string[] = [];
  let pageImageRequest: Promise<string[]> | null = null;
  const loadPageImages = () => {
    if (pageImages.length) return Promise.resolve(pageImages);
    if (pageImageRequest) return pageImageRequest;

    pageImageRequest = renderPdfToImagePages(params.bytes, {
      maxPages: PDF_SMART_SPLIT_MAX_PAGES,
      sourceName: params.fileName,
    })
      .then((rendered) => {
        pageImages = rendered;
        return rendered;
      })
      .catch((error) => {
        const reason =
          error instanceof Error
            ? error.message
            : String(error ?? "Unknown error");
        if (!hasMeaningfulTextPages(params.textPages)) {
          throw new Error(
            `Unable to render scanned PDF "${params.fileName}". Check the PDF file and the native canvas function bundle. ${reason}`,
          );
        }
        console.warn(
          `Unable to render PDF "${params.fileName}" for document recognition. Continuing with text only. ${reason}`,
        );
        return [];
      });
    return pageImageRequest;
  };

  if (!hasMeaningfulTextPages(params.textPages)) {
    pageImages = await loadPageImages();
  }

  const groups = await splitPdfIntoDocumentGroups({
    fileName: params.fileName,
    textPages: params.textPages,
    pageImages,
    loadPageImages,
  });
  const documents = await extractPdfDocumentGroups({
    fileName: params.fileName,
    textPages: params.textPages,
    pageImages,
    loadPageImages,
    groups,
    onGroupProgress: ({ current, total, group }) =>
      params.onGroupProgress?.({
        current,
        total,
        documentType: group.documentType,
      }),
  });

  return {
    documents,
    reviewImages: await loadPageImages(),
  };
}

export async function extractUploadedPacketFile(params: {
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string | null;
}) {
  const mimeType = getFileMimeType(params.fileName, params.mimeType ?? null);
  let documents: CaseDoc[];
  let reviewImages: string[];

  if (mimeType.startsWith("image/")) {
    const image = await normalizePageImageOrientation(
      await imageBytesToProviderDataUrl(
        params.bytes,
        mimeType,
        params.fileName,
      ),
      `${params.fileName} page 1`,
    );
    const documentType = await classifyDocumentFromImage(
      image,
      params.fileName,
    );
    let document = await extractDataFromImagePages({
      fileName: params.fileName,
      pageImages: [image],
      documentType,
    });
    document = await retryWeakImageExtraction({
      document,
      fileName: params.fileName,
      pageImages: [image],
      documentType,
    });
    documents = [document];
    reviewImages = [image];
  } else if (mimeType === "application/pdf") {
    const textPages = await extractPdfTextPages(params.bytes.slice());
    const extracted = await extractPdfPacketDocuments({
      bytes: params.bytes,
      fileName: params.fileName,
      textPages,
    });
    documents = extracted.documents;
    reviewImages = extracted.reviewImages;
  } else {
    throw new Error(
      `Unsupported document format for "${params.fileName}". Upload a PDF or image document.`,
    );
  }

  for (const document of documents) {
    document.sourceHint = document.sourceHint ?? params.fileName;
    document.sourceFileName = document.sourceFileName ?? params.fileName;
  }

  return { documents, reviewImages };
}

export async function processStoredCaseFiles(params: {
  caseId: string;
  analysisMode?: CaseAnalysisMode;
  comparisonOptions?: unknown;
  onProgress?: (details: {
    progress: number;
    stage: string;
  }) => Promise<void> | void;
}) {
  const supabase = createSupabaseAdminClient();
  const fieldConfiguration = await getPersistedPacketFieldConfiguration();
  const comparisonOptions = readComparisonOptions(
    params.comparisonOptions ?? DEFAULT_COMPARISON_OPTIONS,
  );
  const analysisMode = params.analysisMode ?? "standard";

  const { data: files, error: filesError } = await supabase
    .from("packet_case_files")
    .select(
      "id, original_name, storage_bucket, storage_path, mime_type, content_sha256",
    )
    .eq("case_id", params.caseId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (filesError) {
    throw filesError;
  }

  if (!files?.length) {
    throw new Error("No files found for this case.");
  }

  const documents: CaseDoc[] = [];
  const reviewPages: ReviewSourcePage[] = [];
  let totalPages = 0;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const bucket = file.storage_bucket || STORAGE_BUCKET;
    const fileProgress = (phase: number) =>
      Math.min(
        79,
        Math.max(5, Math.round(5 + ((index + phase) / files.length) * 72)),
      );

    await params.onProgress?.({
      progress: fileProgress(0.05),
      stage: `Reading file ${index + 1} of ${files.length}: ${file.original_name}`,
    });

    const download = await supabase.storage
      .from(bucket)
      .download(file.storage_path);
    if (download.error) {
      throw download.error;
    }

    const bytes = new Uint8Array(await download.data.arrayBuffer());
    if (
      createHash("sha256").update(bytes).digest("hex") !== file.content_sha256
    )
      throw new Error(
        "Invalid file checksum. Upload the original document again.",
      );
    const mimeType = getFileMimeType(file.original_name, file.mime_type);

    let fileDocuments: CaseDoc[] = [];
    let fileReviewImages: string[] = [];
    if (mimeType.startsWith("image/")) {
      totalPages += 1;
      if (totalPages > 40)
        throw new Error("Page limit exceeded: a case supports up to 40 pages.");
      await params.onProgress?.({
        progress: fileProgress(0.35),
        stage: `Extracting file ${index + 1} of ${files.length}: ${file.original_name}`,
      });
      const image = await normalizePageImageOrientation(
        await imageBytesToProviderDataUrl(bytes, mimeType, file.original_name),
        `${file.original_name} page 1`,
      );
      fileReviewImages = [image];
      const documentType = await classifyDocumentFromImage(
        image,
        file.original_name,
      );
      let document = await extractDataFromImagePages({
        fileName: file.original_name,
        pageImages: [image],
        documentType,
      });
      document = await retryWeakImageExtraction({
        document,
        fileName: file.original_name,
        pageImages: [image],
        documentType,
      });
      fileDocuments = [document];
    } else if (mimeType === "application/pdf") {
      const textPages = await extractPdfTextPages(bytes.slice());
      totalPages += textPages.length;
      if (totalPages > 40)
        throw new Error(
          "Page limit exceeded: a case supports up to 40 pages. Split the documents into smaller cases.",
        );
      await params.onProgress?.({
        progress: fileProgress(0.18),
        stage: `Identifying documents in PDF ${index + 1} of ${files.length}: ${file.original_name}`,
      });

      // Analysis mode controls whether unrelated packet groups become separate
      // cases. It must never control document recognition: a PDF containing an
      // invoice, PO, e-way bill, and weighment slip still contains four distinct
      // documents even when the user wants them kept together as one case.
      const extractedPdf = await extractPdfPacketDocuments({
        bytes,
        fileName: file.original_name,
        textPages,
        onGroupProgress: async ({ current, total, documentType }) => {
          await params.onProgress?.({
            progress: fileProgress(0.2 + (current / Math.max(1, total)) * 0.72),
            stage: `Extracting document ${current} of ${total} from PDF ${index + 1} of ${files.length}: ${formatDocType(documentType)}`,
          });
        },
      });
      fileDocuments = extractedPdf.documents;
      fileReviewImages = extractedPdf.reviewImages;
    } else {
      fileDocuments = [
        fallbackDoc(
          file.original_name,
          inferDocTypeFromFilename(file.original_name),
        ),
      ];
    }

    fileReviewImages.forEach((image, pageIndex) => {
      reviewPages.push({
        sourceFileName: file.original_name,
        pageNumber: pageIndex + 1,
        image,
      });
    });

    for (const document of fileDocuments) {
      if (mimeType.startsWith("image/")) document.sourcePageNumbers = [1];
      document.sourceHint = document.sourceHint ?? file.original_name;
      document.sourceFileName = document.sourceFileName ?? file.original_name;
      documents.push(document);
    }
  }

  const canonicalDocuments = collapseDuplicateInvoiceCopies(documents);
  const enrichedDocuments = enrichProcessedDocuments(canonicalDocuments);
  const verificationResult = buildProcessedVerificationResult(
    verifyGroupedCaseDocuments(enrichedDocuments, comparisonOptions),
  );
  await params.onProgress?.({
    progress: 80,
    stage: `Comparing ${enrichedDocuments.length} extracted documents across ${verificationResult.verificationGroups.length} packet group${verificationResult.verificationGroups.length === 1 ? "" : "s"}`,
  });

  await params.onProgress?.({
    progress: 83,
    stage: "Extraction complete; preparing source review",
  });
  const summary = summarizeCase(
    enrichedDocuments,
    verificationResult.mismatches,
    fieldConfiguration,
  );

  return {
    documents: enrichedDocuments,
    mismatches: verificationResult.mismatches,
    summary,
    comparisonOptions,
    analysisMode,
    fieldConfiguration,
    verificationGroups: verificationResult.verificationGroups,
    reviewPages: await prepareAuthoritativeReviewPages(reviewPages),
  };
}
