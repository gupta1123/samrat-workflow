import { findVehicles } from "./sap-vehicles";

export type SapInspectorDataset = "open-po" | "po" | "grpo" | "ap-invoice";

export type SapInspectorFinding = {
  severity: "ok" | "warning" | "blocked";
  title: string;
  detail: string;
};

export type SapInspectorMatchReferences = {
  invoice: string | null;
  eWayBill: string | null;
  lorryReceipt: string | null;
  vehicle: string | null;
};

type SapInspectorOptions = {
  feed?: "service-layer" | "spapi";
  poReferenceFields?: readonly string[];
  vehicleField?: string | null;
  invoiceField?: string | null;
  eWayBillField?: string | null;
  lorryReceiptField?: string | null;
  purchaseOrders?: readonly Record<string, unknown>[];
};

export type SapInspectorLine = {
  lineNumber: string | null;
  itemCode: string | null;
  description: string | null;
  quantity: number | null;
  openQuantity: number | null;
  price: number | null;
  lineTotal: number | null;
  status: string | null;
  warehouse: string | null;
  baseType: number | null;
  baseEntry: number | null;
  baseLine: number | null;
  linkedPoNumber?: string | null;
  linkedPoPrice?: number | null;
  linkedPoQuantity?: number | null;
  linkedPoReferences?: string[];
  matchReferences?: SapInspectorMatchReferences;
  raw: Record<string, unknown>;
};

export type SapInspectorRecord = {
  id: string;
  dataset: SapInspectorDataset;
  docEntry: string | null;
  docNumber: string | null;
  date: string | null;
  taxDate: string | null;
  vendorCode: string | null;
  vendorName: string | null;
  vendorReference: string | null;
  total: number | null;
  currency: string | null;
  status: string;
  cancelled: boolean;
  branchId: string | null;
  comments: string | null;
  poReferences: string[];
  matchReferences?: SapInspectorMatchReferences;
  lines: SapInspectorLine[];
  findings: SapInspectorFinding[];
  raw: Record<string, unknown>;
};

export type SapInspectorResponse = {
  dataset: SapInspectorDataset;
  source:
    "SPAPI" | "SPAPI OpenGRPO fallback" | "SAP Business One Service Layer";
  environment: "test" | "live";
  fetchedAt: string;
  limit: number;
  truncated: boolean;
  records: SapInspectorRecord[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstValue(
  source: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function text(source: Record<string, unknown>, keys: readonly string[]) {
  const value = firstValue(source, keys);
  if (value === null) return null;
  const result = String(value).trim();
  return result || null;
}

function numberValue(
  source: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  const value = firstValue(source, keys);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isCancelled(source: Record<string, unknown>) {
  const value = text(source, ["Cancelled", "Canceled", "cancelled"]);
  return value === "tYES" || value === "Y" || value === "true";
}

function displayStatus(source: Record<string, unknown>, cancelled: boolean) {
  if (cancelled) return "Cancelled";
  const value =
    text(source, ["DocumentStatus", "DocStatus", "LineStatus", "Status"]) ??
    "Unknown";
  return value
    .replace(/^bost_/, "")
    .replace(/^bopost_/, "")
    .replaceAll("_", " ");
}

function normalizeLine(value: unknown): SapInspectorLine {
  const source = record(value);
  return {
    lineNumber: text(source, ["LineNum", "PO Line Num", "BaseLine"]),
    itemCode: text(source, ["ItemCode", "Item Code"]),
    description: text(source, ["ItemDescription", "Dscription", "Description"]),
    quantity: numberValue(source, ["Quantity", "Qty"]),
    openQuantity: numberValue(source, [
      "RemainingOpenQuantity",
      "OpenQuantity",
      "OpenQty",
      "Open Qty",
    ]),
    price: numberValue(source, ["UnitPrice", "Price", "PriceAfterVAT"]),
    lineTotal: numberValue(source, ["LineTotal", "Line Total", "Total Amount"]),
    status: text(source, ["LineStatus", "Status"]),
    warehouse: text(source, ["WarehouseCode", "WhsCode", "Warehouse"]),
    baseType: numberValue(source, ["BaseType", "Base Type"]),
    baseEntry: numberValue(source, [
      "BaseEntry",
      "Base PO DocEntry",
      "PO DocEntry",
    ]),
    baseLine: numberValue(source, ["BaseLine", "Base PO Line", "PO Line Num"]),
    raw: source,
  };
}

function configuredReferences(
  source: Record<string, unknown>,
  dataset: SapInspectorDataset,
  poReferenceFields: readonly string[],
) {
  const references = [
    text(source, ["DocNum", "Document Number", "PO Number"]),
    text(source, ["NumAtCard", "Vendor Reference", "VendorRef"]),
    ...(dataset === "po"
      ? poReferenceFields.map((field) => text(source, [field]))
      : []),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(references)];
}

function findingsFor(input: {
  dataset: SapInspectorDataset;
  feed: "service-layer" | "spapi";
  source: Record<string, unknown>;
  lines: SapInspectorLine[];
  cancelled: boolean;
  status: string;
  docEntry: string | null;
  docNumber: string | null;
  vendorCode: string | null;
  vendorReference: string | null;
  poReferences: string[];
  vehicleField?: string | null;
}): SapInspectorFinding[] {
  const findings: SapInspectorFinding[] = [];
  const add = (
    severity: SapInspectorFinding["severity"],
    title: string,
    detail: string,
  ) => findings.push({ severity, title, detail });

  if (!input.docNumber) {
    add(
      "blocked",
      "Document number is missing",
      "Samrat cannot display or compare this SAP record by document number.",
    );
  }
  if (!input.docEntry) {
    add(
      input.feed === "spapi" ? "warning" : "blocked",
      input.feed === "spapi"
        ? "DocEntry is not exposed by this feed"
        : "DocEntry is missing",
      input.feed === "spapi"
        ? "The operational SPAPI row omits SAP's internal DocEntry, so this page cannot verify base-document links from this response alone."
        : "SAP base-document links require the internal DocEntry value.",
    );
  }
  if (!input.vendorCode) {
    add(
      "blocked",
      "Vendor code is missing",
      "Matching starts with the exact SAP supplier code, so this row cannot join to an invoice vendor.",
    );
  }
  if (input.cancelled) {
    add(
      "blocked",
      "Document is cancelled",
      "Cancelled SAP documents are deliberately excluded from matching.",
    );
  } else if (/closed/i.test(input.status)) {
    add(
      "blocked",
      "Document is closed",
      "Closed documents have no remaining quantity available for a new match.",
    );
  }

  if (!input.lines.length) {
    add(
      "blocked",
      "No document lines were returned",
      "Samrat matches invoice items to SAP lines; a header without lines cannot be allocated.",
    );
  }

  if (input.dataset === "po" || input.dataset === "open-po") {
    const quantities = input.lines
      .map((line) => line.openQuantity)
      .filter((value): value is number => value !== null);
    if (quantities.length && quantities.every((value) => value <= 0)) {
      add(
        "blocked",
        "No open quantity remains",
        "Every returned PO line has zero open quantity, so the invoice cannot use this PO.",
      );
    }
    if (input.poReferences.length <= 1) {
      add(
        "warning",
        "Only the SAP document number identifies this PO",
        "If the vendor invoice prints a different PO reference, configure the SAP PO reference UDF so Samrat can find it exactly.",
      );
    }
  }

  if (input.dataset === "grpo") {
    const linkedLines = input.lines.filter(
      (line) => line.baseType === 22 && line.baseEntry !== null,
    );
    if (!linkedLines.length) {
      add(
        input.feed === "spapi" ? "warning" : "blocked",
        input.feed === "spapi"
          ? "PO base link is not exposed by this feed"
          : "No Purchase Order base link",
        input.feed === "spapi"
          ? "OpenGRPO does not return BaseType, BaseEntry, or BaseLine, so the PO relationship cannot be verified from this operational response."
          : "Samrat expects GRPO lines to carry BaseType 22 and a BaseEntry pointing to the source PO.",
      );
    }
    const quantities = input.lines
      .map((line) => line.openQuantity)
      .filter((value): value is number => value !== null);
    if (quantities.length && quantities.every((value) => value <= 0)) {
      add(
        "blocked",
        "GRPO is fully invoiced",
        "No remaining open receipt quantity is available for another AP invoice.",
      );
    }
    if (!input.vendorReference) {
      add(
        "warning",
        "Vendor invoice reference is blank",
        "Stores may need to record the vendor invoice number on the GRPO for a strong exact match.",
      );
    }
    if (
      input.vehicleField &&
      !input.lines.some((line) => line.matchReferences?.vehicle) &&
      !text(input.source, [input.vehicleField, "Comments"])
    ) {
      add(
        "warning",
        "Truck number is not visible",
        `Neither ${input.vehicleField} nor Comments contains a truck reference for vehicle verification.`,
      );
    }
  }

  if (input.dataset === "ap-invoice") {
    if (!input.vendorReference) {
      add(
        "blocked",
        "Vendor invoice number is blank",
        "Samrat checks existing AP invoices using the exact vendor code and NumAtCard. A blank value prevents duplicate detection.",
      );
    }
    const basedLines = input.lines.filter(
      (line) =>
        (line.baseType === 20 || line.baseType === 22) &&
        line.baseEntry !== null,
    );
    if (input.lines.length && !basedLines.length) {
      add(
        "warning",
        "No GRPO or PO base links",
        "The AP invoice lines do not show BaseType 20/22 links, so the purchasing chain cannot be traced from this response.",
      );
    }
  }

  if (!findings.length) {
    add(
      "ok",
      "No obvious structural blocker",
      "The key SAP identifiers and relationships required by Samrat are present. Use search to compare the exact vendor, reference, item, and quantities.",
    );
  }
  return findings;
}

export function normalizeSapInspectorRecord(
  dataset: SapInspectorDataset,
  value: unknown,
  index: number,
  options: SapInspectorOptions = {},
): SapInspectorRecord {
  const source = record(value);
  const embeddedLines = Array.isArray(source.DocumentLines)
    ? source.DocumentLines
    : Array.isArray(source.Lines)
      ? source.Lines
      : null;
  const matchRefs = (
    line: Record<string, unknown>,
  ): SapInspectorMatchReferences => {
    const field = (name: string | null | undefined) =>
      name ? (text(line, [name]) ?? text(source, [name])) : null;
    return {
      invoice: field(options.invoiceField) ?? text(source, ["NumAtCard"]),
      eWayBill: field(options.eWayBillField),
      lorryReceipt: field(options.lorryReceiptField),
      vehicle:
        findVehicles(field(options.vehicleField))[0] ??
        findVehicles(source.Comments)[0] ??
        null,
    };
  };
  const lines = (embeddedLines ?? [source]).map((value) => {
    const line = normalizeLine(value);
    if (dataset !== "grpo") return line;
    // Match the price source used by mapReceiptLines, rather than UnitPrice.
    line.price = numberValue(record(value), ["Price"]);
    const po =
      line.baseType === 22 && line.baseEntry !== null
        ? options.purchaseOrders?.find(
            (po) => Number(po.DocEntry) === line.baseEntry,
          )
        : undefined;
    const poLine = po && Array.isArray(po.DocumentLines)
      ? po.DocumentLines.map(record).find(candidate => Number(candidate.LineNum) === line.baseLine)
      : undefined;
    return {
      ...line,
      linkedPoNumber: po ? text(po, ["DocNum"]) : null,
      linkedPoPrice: poLine ? numberValue(poLine, ["Price", "UnitPrice"]) : null,
      linkedPoQuantity: poLine ? numberValue(poLine, ["Quantity"]) : null,
      linkedPoReferences: po
        ? configuredReferences(po, "po", options.poReferenceFields ?? [])
        : [],
      matchReferences: matchRefs(record(value)),
    };
  });
  const cancelled = isCancelled(source);
  const reportedStatus = displayStatus(source, cancelled);
  const status =
    (dataset === "open-po" ||
      (dataset === "grpo" && options.feed === "spapi")) &&
    reportedStatus === "Unknown"
      ? "Open"
      : reportedStatus;
  const docEntry = text(source, ["DocEntry", "Document Entry"]);
  const docNumber = text(source, ["DocNum", "Document Number", "PO Number"]);
  const vendorCode = text(source, ["CardCode", "BP Code", "Vendor Code"]);
  const vendorReference = text(source, [
    "NumAtCard",
    "Vendor Reference",
    "VendorRef",
    "Invoice Number",
  ]);
  const poReferences =
    dataset === "grpo"
      ? [...new Set(lines.flatMap((line) => line.linkedPoReferences ?? []))]
      : configuredReferences(source, dataset, options.poReferenceFields ?? []);
  const findings = findingsFor({
    dataset,
    feed: options.feed ?? "service-layer",
    source,
    lines,
    cancelled,
    status,
    docEntry,
    docNumber,
    vendorCode,
    vendorReference:
      dataset === "grpo"
        ? (lines.find((line) => line.matchReferences?.invoice)?.matchReferences
            ?.invoice ?? vendorReference)
        : vendorReference,
    poReferences,
    vehicleField: options.vehicleField,
  });

  return {
    id: `${dataset}:${docEntry ?? docNumber ?? index}:${index}`,
    dataset,
    docEntry,
    docNumber,
    date: text(source, ["DocDate", "Posting Date", "Document Date", "Date"]),
    taxDate: text(source, ["TaxDate", "Doc Date", "Tax Date"]),
    vendorCode,
    vendorName: text(source, ["CardName", "BP Name", "Vendor Name"]),
    vendorReference,
    total: numberValue(source, ["DocTotal", "Total Amount", "Document Total"]),
    currency: text(source, ["DocCurrency", "Currency"]),
    status,
    cancelled,
    branchId: text(source, ["BPL_IDAssignedToInvoice", "Branch", "BPLId"]),
    comments: text(source, ["Comments", "Remarks"]),
    poReferences,
    lines,
    findings,
    ...(dataset === "grpo" ? { matchReferences: matchRefs({}) } : {}),
    raw: source,
  };
}

export function normalizeSapInspectorRecords(
  dataset: SapInspectorDataset,
  values: unknown[],
  options?: SapInspectorOptions,
) {
  return values.map((value, index) =>
    normalizeSapInspectorRecord(dataset, value, index, options),
  );
}
