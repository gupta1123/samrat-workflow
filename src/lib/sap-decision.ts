export type SapPostingKind = "GRN" | "AP";

export type SapCaseDocumentInput = {
  id: string;
  documentType: string;
  extractedFields?: Record<string, unknown> | null;
};

export type SapClassification = {
  hasPurchaseOrder: boolean;
  hasReceiptEvidence: boolean;
  hasVendorInvoice: boolean;
  poNumber: string | null;
  invoiceNumber: string | null;
  receiptDocumentTypes: string[];
  plan: SapPostingKind[];
  blockedReason: string | null;
};

const RECEIPT_EVIDENCE_TYPES = new Set([
  "Weighment Slip",
  "Delivery Note",
  "Lorry Receipt",
  "E-Way Bill",
]);

const VENDOR_INVOICE_TYPES = new Set(["Invoice", "Tax Invoice"]);

function present(value: unknown): boolean {
  return (
    (typeof value === "string" || typeof value === "number") &&
    String(value).trim() !== ""
  );
}

export function normalizeSapReference(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s\-_/]+/g, "");
}

function readField(fields: Record<string, unknown> | null | undefined, key: string): unknown {
  if (!fields || typeof fields !== "object") return undefined;
  return (fields as Record<string, unknown>)[key];
}

function readPoNumber(
  casePoNumber: unknown,
  documents: SapCaseDocumentInput[],
): string | null {
  if (present(casePoNumber)) return String(casePoNumber).trim();
  for (const document of documents) {
    const value =
      readField(document.extractedFields, "poNumber") ??
      readField(document.extractedFields, "purchaseOrderNumber");
    if (present(value)) return String(value).trim();
  }
  return null;
}

function readInvoiceNumber(
  caseInvoiceNumber: unknown,
  documents: SapCaseDocumentInput[],
): string | null {
  if (present(caseInvoiceNumber)) return String(caseInvoiceNumber).trim();
  for (const document of documents) {
    const value = readField(document.extractedFields, "invoiceNumber");
    if (present(value)) return String(value).trim();
  }
  return null;
}

export function classifySapCase(params: {
  casePoNumber: unknown;
  caseInvoiceNumber: unknown;
  documents: SapCaseDocumentInput[];
}): SapClassification {
  const documents = Array.isArray(params.documents) ? params.documents : [];
  const types = documents.map((document) => document.documentType);
  const hasPurchaseOrderDoc = types.some(
    (type) => type === "Purchase Order" || type === "Amended Purchase Order",
  );
  const poNumber = readPoNumber(params.casePoNumber, documents);
  const invoiceNumber = readInvoiceNumber(params.caseInvoiceNumber, documents);
  const receiptDocumentTypes = [...new Set(types.filter((type) => RECEIPT_EVIDENCE_TYPES.has(type)))];
  const hasReceiptEvidence = receiptDocumentTypes.length > 0;
  const hasVendorInvoice = documents.some(
    (document) =>
      VENDOR_INVOICE_TYPES.has(document.documentType) &&
      present(readField(document.extractedFields, "invoiceNumber")),
  );

  const plan: SapPostingKind[] = [];
  if ((hasPurchaseOrderDoc || present(poNumber)) && hasReceiptEvidence) {
    plan.push("GRN");
  }
  if (hasVendorInvoice) {
    plan.push("AP");
  }

  let blockedReason: string | null = null;
  if (plan.length === 0) {
    if (!present(poNumber) && !hasVendorInvoice) {
      blockedReason =
        "No purchase-order number and no numbered vendor invoice were extracted. Analyze the packet again before posting to SAP.";
    } else if (!hasReceiptEvidence && !hasVendorInvoice) {
      blockedReason =
        "No goods-receipt evidence (weighment slip, delivery note, lorry receipt, e-way bill) and no vendor invoice were found in this packet.";
    } else if (!present(poNumber) && hasReceiptEvidence && !hasVendorInvoice) {
      blockedReason =
        "Goods-receipt evidence is present but the purchase-order number is missing, so a GRN cannot be matched to SAP.";
    } else {
      blockedReason =
        "This packet does not contain enough evidence to decide between a GRN and an AP invoice.";
    }
  }

  return {
    hasPurchaseOrder: hasPurchaseOrderDoc || present(poNumber),
    hasReceiptEvidence,
    hasVendorInvoice,
    poNumber,
    invoiceNumber,
    receiptDocumentTypes,
    plan,
    blockedReason,
  };
}

export type SapCandidateRow = {
  docNum: string | number;
  vendorName: unknown;
  totalAmount: unknown;
  itemDescription?: unknown;
  docDate?: unknown;
};

export type SapCandidate = {
  docNum: string;
  vendorName: string | null;
  totalAmount: number | null;
  score: number;
  reasons: string[];
};

const VENDOR_STOP_WORDS = new Set([
  "PVT",
  "PRIVATE",
  "LIMITED",
  "LTD",
  "INC",
  "CORP",
  "CORPORATION",
  "LLP",
  "CO",
  "COMPANY",
  "AND",
  "&",
  "THE",
]);

function vendorTokens(name: unknown): Set<string> {
  const tokens = String(name ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !VENDOR_STOP_WORDS.has(token));
  return new Set(tokens);
}

export function scoreVendorNames(caseVendor: unknown, sapVendor: unknown): number {
  const left = vendorTokens(caseVendor);
  const right = vendorTokens(sapVendor);
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  // Fraction of the case vendor's tokens found in the SAP vendor name.
  return common / left.size;
}

export function parseSapAmount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Rank open SAP rows when the PO number does not match a DocNum directly.
 * Real PO numbers (SIPL/PO/26-27/1204) never equal SAP's integer DocNums, so
 * vendor overlap + total proximity produce a pick-list for the reviewer.
 */
export function rankSapCandidates(params: {
  caseVendor: unknown;
  caseTotal: unknown;
  rows: SapCandidateRow[];
  limit?: number;
}): SapCandidate[] {
  const limit = params.limit ?? 5;
  const caseTotal = parseSapAmount(params.caseTotal);
  const scored: SapCandidate[] = [];
  for (const row of params.rows) {
    if (row.docNum === null || row.docNum === undefined || String(row.docNum).trim() === "") {
      continue;
    }
    const vendorScore = scoreVendorNames(params.caseVendor, row.vendorName);
    const rowTotal = parseSapAmount(row.totalAmount);
    let amountScore = 0;
    const reasons: string[] = [];
    if (vendorScore >= 0.5) {
      reasons.push(
        vendorScore >= 1 ? "same vendor" : "vendor closely matches",
      );
    }
    if (caseTotal !== null && caseTotal > 0 && rowTotal !== null) {
      const drift = Math.abs(rowTotal - caseTotal) / caseTotal;
      if (drift <= 0.01) {
        amountScore = 1;
        reasons.push("total matches");
      } else if (drift <= 0.05) {
        amountScore = 0.6;
        reasons.push("total within 5%");
      }
    }
    const score = vendorScore * 0.6 + amountScore * 0.4;
    // A bare token overlap (e.g. "STEEL") with no vendor or amount reason
    // is noise, not a candidate.
    if (score <= 0 || reasons.length === 0) continue;
    scored.push({
      docNum: String(row.docNum).trim(),
      vendorName:
        typeof row.vendorName === "string" && row.vendorName.trim()
          ? row.vendorName.trim()
          : null,
      totalAmount: rowTotal,
      score: Math.round(score * 100) / 100,
      reasons,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function matchSapReference(
  caseReference: string | null,
  sapDocNums: Array<string | number | null | undefined>,
): string | null {
  if (!present(caseReference)) return null;
  const wanted = normalizeSapReference(caseReference);
  if (!wanted) return null;
  for (const candidate of sapDocNums) {
    if (!present(candidate)) continue;
    if (normalizeSapReference(candidate) === wanted) return String(candidate).trim();
  }
  return null;
}
