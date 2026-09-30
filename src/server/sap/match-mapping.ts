// Pure translators between stored/SAP data and the matching engine's types.
// No network or database access here, so all of it is unit-tested.

import {
  DEFAULT_MATCH_RULES,
  type BranchMapping,
  type MatchInvoice,
  type MatchInvoiceLine,
  type MatchRules,
  type SapPoLine,
  type SapReceiptLine,
} from "@/lib/sap-match/types";
import { parseSapAmount } from "@/lib/sap-decision";
import { readStoredLineItems } from "@/server/line-items";
import { sapInvoiceDate } from "./dates";
import type { SapMatchDocument } from "./service-layer";

type StoredDocument = {
  document_type: unknown;
  extracted_fields: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function amount(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/\d/.test(value))) {
    return null;
  }
  return parseSapAmount(value);
}

const VEHICLE_PATTERN = /\b[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{0,3}[\s-]?\d{4}\b/g;

/** Vehicle registrations found in free text, normalised (no spaces or dashes). */
export function findVehicles(value: unknown): string[] {
  const source = text(value).toUpperCase();
  if (!source) return [];
  return [
    ...new Set(
      (source.match(VEHICLE_PATTERN) ?? []).map((match) => match.replace(/[\s-]/g, "")),
    ),
  ];
}

const INVOICE_TYPES = new Set(["Invoice", "Tax Invoice"]);
const FREIGHT_LINE = /freight|transport|cartage|lorry/i;

/**
 * Builds the engine's invoice from the saved packet. Returns null when the
 * packet has no numbered vendor invoice (there is nothing to match).
 */
export function buildMatchInvoice(input: {
  caseInvoiceNumber: unknown;
  casePoNumber: unknown;
  documents: StoredDocument[];
}): MatchInvoice | null {
  const invoices = input.documents.filter((document) =>
    INVOICE_TYPES.has(String(document.document_type)),
  );
  const wanted = text(input.caseInvoiceNumber);
  const primary =
    invoices.find((document) => text(record(document.extracted_fields).invoiceNumber) === wanted) ??
    invoices.find((document) => text(record(document.extracted_fields).invoiceNumber));
  if (!primary) return null;
  const fields = record(primary.extracted_fields);
  const invoiceNumber = text(fields.invoiceNumber);
  if (!invoiceNumber) return null;

  const rawLines = readStoredLineItems(primary.extracted_fields);
  let freightFromLines = 0;
  const lines: MatchInvoiceLine[] = [];
  for (const item of rawLines) {
    const description = text(item.description);
    const code = text(item.itemCode);
    const lineAmount = amount(item.taxableAmount) ?? amount(item.lineTotal);
    // A freight line is a charge on the invoice, not a stock item to match.
    if (!code && FREIGHT_LINE.test(description) && lineAmount !== null) {
      freightFromLines += lineAmount;
      continue;
    }
    lines.push({
      index: lines.length,
      vendorItemCode: code || null,
      description: description || null,
      hsnSac: text(item.hsnSac) || null,
      quantity: amount(item.quantity),
      unit: text(item.unit) || null,
      rate: amount(item.rate),
      amount: lineAmount,
    });
  }

  const vehicles = new Set<string>();
  const poReferences = new Set<string>();
  let eWayBill: string | null = null;
  let lorryReceipt: string | null = null;
  for (const document of input.documents) {
    const documentFields = record(document.extracted_fields);
    for (const vehicle of findVehicles(documentFields.vehicleNumber)) vehicles.add(vehicle);
    for (const key of ["poNumber", "referencePoNumber"]) {
      const value = text(documentFields[key]);
      if (value) poReferences.add(value);
    }
    if (!eWayBill) eWayBill = text(documentFields.eWayBillNumber) || null;
    if (!lorryReceipt) lorryReceipt = text(documentFields.lorryReceiptNumber) || null;
  }
  const casePo = text(input.casePoNumber);
  if (casePo) poReferences.add(casePo);

  const cgst = amount(fields.cgstRate);
  const sgst = amount(fields.sgstRate);
  const igst = amount(fields.igstRate);
  const igstOnLines = rawLines.some((item) => (amount(item.igstAmount) ?? 0) > 0);
  const splitOnLines = rawLines.some(
    (item) => (amount(item.cgstAmount) ?? 0) > 0 || (amount(item.sgstAmount) ?? 0) > 0,
  );
  const taxCharged: MatchInvoice["taxCharged"] =
    (igst ?? 0) > 0 || igstOnLines
      ? "igst"
      : (cgst ?? 0) > 0 || (sgst ?? 0) > 0 || splitOnLines
        ? "split"
        : "unknown";

  const freightField = amount(fields.freightAmount);
  const freightAmount = freightField ?? (freightFromLines > 0 ? freightFromLines : 0);

  return {
    invoiceNumber,
    invoiceDate: sapInvoiceDate(fields.documentDate),
    vendorName: text(fields.vendorName) || text(fields.supplierName) || null,
    vendorGstin: text(fields.supplierGstin) || null,
    shipToGstin: text(fields.shipToGstin) || text(fields.buyerGstin) || null,
    poReferences: [...poReferences],
    vehicles: [...vehicles],
    eWayBill,
    lorryReceipt,
    taxCharged,
    taxRatePct: (igst ?? 0) > 0 ? igst : cgst !== null && sgst !== null ? cgst + sgst : amount(fields.taxRate),
    currency: text(fields.currency).toUpperCase() || null,
    freightAmount,
    taxableTotal: amount(fields.totalTaxableAmount) ?? amount(fields.subtotal),
    taxTotal: amount(fields.taxAmount),
    total: amount(fields.totalAmount),
    lines,
  };
}

// ---- Vendor ----

type VendorSupplier = {
  CardCode: string;
  CardName: string;
  BPAddresses?: Array<{ GSTIN?: string | null }>;
};

function exactName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleUpperCase("en-IN")
    .split(" ")
    .filter(Boolean)
    .join(" ");
}

function exactGstin(value: unknown): string {
  return String(value ?? "").trim().toLocaleUpperCase("en-IN");
}

export function resolveVendor(
  invoice: { vendorName: string | null; vendorGstin: string | null },
  suppliers: VendorSupplier[],
): {
  vendor: { cardCode: string; cardName: string } | null;
  ambiguous: Array<{ cardCode: string; cardName: string; why: string }>;
} {
  const toVendor = (row: VendorSupplier) => ({
    cardCode: row.CardCode,
    cardName: row.CardName,
  });

  const gstin = exactGstin(invoice.vendorGstin);
  if (gstin) {
    const gstinMatches = suppliers.filter((supplier) =>
      (supplier.BPAddresses ?? []).some(
        (address) => exactGstin(address.GSTIN) === gstin,
      ),
    );
    if (gstinMatches.length === 1) {
      return { vendor: toVendor(gstinMatches[0]), ambiguous: [] };
    }
    if (gstinMatches.length > 1) {
      return {
        vendor: null,
        ambiguous: gstinMatches.map((supplier) => ({
          ...toVendor(supplier),
          why: "Exact GSTIN match",
        })),
      };
    }
  }

  const name = exactName(invoice.vendorName);
  if (!name) return { vendor: null, ambiguous: [] };
  const nameMatches = suppliers.filter(
    (supplier) => exactName(supplier.CardName) === name,
  );
  if (nameMatches.length === 1) {
    return { vendor: toVendor(nameMatches[0]), ambiguous: [] };
  }
  if (nameMatches.length > 1) {
    return {
      vendor: null,
      ambiguous: nameMatches.map((supplier) => ({
        ...toVendor(supplier),
        why: "Exact vendor-name match",
      })),
    };
  }
  return { vendor: null, ambiguous: [] };
}

/** Exact identities that are safe to reuse across cases after reviewer confirmation. */
export function vendorKeys(invoice: {
  vendorGstin: string | null;
  vendorName: string | null;
  lines?: Array<{ vendorItemCode?: string | null }>;
}): string[] {
  const gstin = exactGstin(invoice.vendorGstin);
  if (gstin.length === 15) {
    const materialCodes = [
      ...new Set(
        (invoice.lines ?? [])
          .map((line) => exactName(line.vendorItemCode))
          .filter(Boolean),
      ),
    ].sort();
    return materialCodes.map((materialCode) =>
      `G:${gstin}|I:${materialCode}`,
    );
  }
  const name = exactName(invoice.vendorName);
  return name ? [`N:${name}`] : [];
}

// ---- SAP documents → engine lines ----

export type SapFieldConfig = {
  /** User-defined field on the receipt that stores the truck number, e.g. U_VehicleNo. */
  vehicleField?: string;
  /** User-defined receipt fields carrying exact packet identifiers. */
  invoiceRefField?: string;
  eWayBillField?: string;
  lorryReceiptField?: string;
  /** User-defined fields on the PO that carry the PO number printed on vendor invoices. */
  poRefFields?: string[];
};

function integer(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) ? number : null;
}

function poRefsOf(document: SapMatchDocument | undefined, config: SapFieldConfig) {
  if (!document) return [];
  const refs = [text(document.DocNum), text(document.NumAtCard)];
  for (const field of config.poRefFields ?? []) refs.push(text(document[field]));
  return [...new Set(refs.filter(Boolean))];
}

export function mapReceiptLines(
  receiptDocuments: SapMatchDocument[],
  purchaseOrders: SapMatchDocument[],
  config: SapFieldConfig = {},
): SapReceiptLine[] {
  const poByEntry = new Map(
    purchaseOrders.flatMap((po) =>
      typeof po.DocEntry === "number" ? [[po.DocEntry, po] as const] : [],
    ),
  );
  const lines: SapReceiptLine[] = [];
  for (const document of receiptDocuments) {
    const docEntry = integer(document.DocEntry);
    const docNum = integer(document.DocNum);
    if (docEntry === null || docNum === null) continue;
    for (const raw of document.DocumentLines ?? []) {
      const line = record(raw);
      const lineNum = integer(line.LineNum);
      const itemCode = text(line.ItemCode);
      const open = amount(line.RemainingOpenQuantity);
      if (lineNum === null || !itemCode || line.LineStatus !== "bost_Open" || open === null || open <= 0) {
        continue;
      }
      const baseType = integer(line.BaseType);
      const poDocEntry = baseType === 22 ? integer(line.BaseEntry) : null;
      const poDocument = poDocEntry !== null ? poByEntry.get(poDocEntry) : undefined;
      const explicitVehicle = config.vehicleField
        ? text(line[config.vehicleField]) || text(document[config.vehicleField])
        : "";
      const vehicle =
        findVehicles(explicitVehicle)[0] ??
        findVehicles(document.Comments)[0] ??
        null;
      const receiptField = (field: string | undefined) =>
        field ? text(line[field]) || text(document[field]) : "";
      lines.push({
        kind: "GRPO",
        docEntry,
        docNum,
        lineNum,
        date: sapInvoiceDate(text(document.DocDate)),
        cardCode: text(document.CardCode),
        itemCode,
        branchId: integer(document.BPL_IDAssignedToInvoice),
        warehouse: text(line.WarehouseCode) || null,
        poDocEntry,
        poDocNum: poDocument ? integer(poDocument.DocNum) : null,
        poLineNum: poDocEntry !== null ? integer(line.BaseLine) : null,
        poRefs: poRefsOf(poDocument, config),
        quantity: amount(line.Quantity) ?? open,
        openQty: open,
        price: amount(line.Price),
        vehicle,
        vendorRef:
          receiptField(config.invoiceRefField) || text(document.NumAtCard) || null,
        eWayBill: receiptField(config.eWayBillField) || null,
        lorryReceipt: receiptField(config.lorryReceiptField) || null,
        note: text(document.Comments) || null,
      });
    }
  }
  return lines;
}

export function mapPoLines(
  purchaseOrders: SapMatchDocument[],
  config: SapFieldConfig = {},
): SapPoLine[] {
  const lines: SapPoLine[] = [];
  for (const document of purchaseOrders) {
    const docEntry = integer(document.DocEntry);
    const docNum = integer(document.DocNum);
    if (docEntry === null || docNum === null) continue;
    for (const raw of document.DocumentLines ?? []) {
      const line = record(raw);
      const lineNum = integer(line.LineNum);
      const itemCode = text(line.ItemCode);
      if (lineNum === null || !itemCode) continue;
      const quantity = amount(line.Quantity) ?? 0;
      const open = amount(line.RemainingOpenQuantity) ?? 0;
      const price = amount(line.Price) ?? amount(line.UnitPrice);
      const lineTotal = amount(line.LineTotal);
      const openAmount =
        line.LineStatus === "bost_Open" && quantity > 0 && lineTotal !== null
          ? Math.round(((lineTotal * open) / quantity) * 100) / 100
          : line.LineStatus === "bost_Open" && lineTotal !== null
            ? lineTotal
            : 0;
      lines.push({
        kind: "PO",
        docEntry,
        docNum,
        lineNum,
        date: sapInvoiceDate(text(document.DocDate)),
        cardCode: text(document.CardCode),
        itemCode,
        branchId: integer(document.BPL_IDAssignedToInvoice),
        warehouse: text(line.WarehouseCode) || null,
        poRefs: poRefsOf(document, config),
        quantity,
        openQty: line.LineStatus === "bost_Open" ? open : 0,
        price,
        lineTotal,
        openAmount,
        description: text(line.ItemDescription) || null,
      });
    }
  }
  return lines;
}

// ---- Rules ----

export type MatchRulesRow = {
  qty_tolerance_pct: unknown;
  rate_tolerance_pct: unknown;
  freight_policy: unknown;
  posting_date: unknown;
  receipt_window_days: unknown;
  branches: unknown;
};

export function parseBranches(value: unknown): BranchMapping[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const branch = record(entry);
    const stateCode = text(branch.stateCode);
    const name = text(branch.name);
    if (!/^\d{2}$/.test(stateCode) || !name) return [];
    return [
      {
        stateCode,
        name,
        bplId: integer(branch.bplId),
        warehouse: text(branch.warehouse) || null,
      },
    ];
  });
}

export function rulesFromRow(row: MatchRulesRow | null | undefined): MatchRules {
  if (!row) return { ...DEFAULT_MATCH_RULES };
  const freight = row.freight_policy;
  return {
    qtyTolerancePct: Number(row.qty_tolerance_pct),
    rateTolerancePct: Number(row.rate_tolerance_pct),
    freightPolicy:
      freight === "item" || freight === "separate" ? freight : "expense",
    postingDate: row.posting_date === "today" ? "today" : "invoice",
    receiptWindowDays: Number(row.receipt_window_days),
    branches: parseBranches(row.branches),
  };
}

/** Validates a rules update from the browser. Throws a readable Error when invalid. */
export function parseRulesInput(input: unknown): MatchRules {
  const body = record(input);
  const number = (value: unknown, name: string, min: number, max: number) => {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      throw new Error(`${name} must be a number between ${min} and ${max}.`);
    }
    return parsed;
  };
  const freight = body.freightPolicy;
  if (freight !== "expense" && freight !== "item" && freight !== "separate") {
    throw new Error("Choose how freight is booked.");
  }
  if (body.postingDate !== "invoice" && body.postingDate !== "today") {
    throw new Error("Choose the booking date rule.");
  }
  const branches = Array.isArray(body.branches) ? body.branches : [];
  const parsedBranches = parseBranches(branches);
  if (parsedBranches.length !== branches.length) {
    throw new Error("Each branch needs a two-digit GST state code and a name.");
  }
  if (new Set(parsedBranches.map((branch) => branch.stateCode)).size !== parsedBranches.length) {
    throw new Error("Each GST state code can be used for only one branch.");
  }
  return {
    qtyTolerancePct: number(body.qtyTolerancePct, "Quantity limit", 0, 100),
    rateTolerancePct: number(body.rateTolerancePct, "Rate limit", 0, 100),
    freightPolicy: freight,
    postingDate: body.postingDate,
    receiptWindowDays: Math.round(number(body.receiptWindowDays, "Receipt window", 0, 365)),
    branches: parsedBranches,
  };
}

export function branchForShipTo(
  shipToGstin: string | null,
  rules: MatchRules,
): { bplId: number | null; name: string; stateCode: string | null; warehouse: string | null } | null {
  const code = (shipToGstin ?? "").trim().slice(0, 2);
  const branch = rules.branches.find((entry) => entry.stateCode === code);
  return branch
    ? {
        bplId: branch.bplId,
        name: branch.name,
        stateCode: branch.stateCode,
        warehouse: branch.warehouse,
      }
    : null;
}
