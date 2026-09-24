import { scoreVendorNames } from "@/lib/sap-decision";

export type InvoiceDraftLine = {
  itemCode?: string | null;
  description?: string | null;
  quantity?: string | number | null;
};

export type SapGrpo = {
  DocEntry?: number;
  DocNum?: number;
  CardCode?: string;
  CardName?: string;
  DocType?: string;
  DocCurrency?: string;
  DocumentStatus?: string;
  Cancelled?: string;
  DocumentLines?: Array<{
    LineNum?: number;
    ItemCode?: string;
    ItemDescription?: string;
    Quantity?: number;
    RemainingOpenQuantity?: number;
    LineStatus?: string;
  }>;
};

export type SapPurchaseOrder = SapGrpo;

function normalized(value: unknown): string {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function quantity(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

type DraftParams = {
  expectedDocEntry: number;
  expectedDocNum: string;
  expectedCardCode: string;
  invoiceVendor: string;
  invoiceNumber: string;
  invoiceLines: InvoiceDraftLine[];
  caseId: string;
  postingDate: string;
  invoiceDate: string;
};

function buildBasedApInvoiceDraft(
  params: DraftParams & { base: SapGrpo; baseKind: "GRPO" | "PO" },
) {
  const { base, baseKind } = params;
  const label = baseKind === "GRPO" ? "GRPO" : "purchase order";
  if (
    base.DocEntry !== params.expectedDocEntry ||
    String(base.DocNum ?? "") !== params.expectedDocNum ||
    base.CardCode !== params.expectedCardCode
  ) {
    throw new Error(`SAP ${label} identity does not match the selected base document.`);
  }
  if (base.Cancelled !== "tNO" || base.DocumentStatus !== "bost_Open") {
    throw new Error(`The selected SAP ${label} is cancelled or no longer open.`);
  }
  if (!params.invoiceVendor.trim() || scoreVendorNames(params.invoiceVendor, base.CardName) < 0.8) {
    throw new Error(`The invoice vendor does not match the selected SAP ${label} vendor.`);
  }
  if (!params.invoiceNumber.trim()) {
    throw new Error("A vendor invoice number is required before creating a draft.");
  }
  if (params.invoiceLines.length === 0) {
    throw new Error("No invoice line items were extracted; review the invoice before creating a draft.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.postingDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(params.invoiceDate)) {
    throw new Error("Valid posting and vendor invoice dates are required for an SAP draft.");
  }
  if (!base.DocCurrency) {
    throw new Error(`The selected SAP ${label} has no currency; review it in SAP.`);
  }

  const available = (base.DocumentLines ?? []).filter(
    (line) =>
      Number.isInteger(line.LineNum) &&
      line.LineStatus === "bost_Open" &&
      typeof line.RemainingOpenQuantity === "number" &&
      line.RemainingOpenQuantity > 0,
  );
  const used = new Set<number>();
  const documentLines = params.invoiceLines.map((invoiceLine, index) => {
    const amount = quantity(invoiceLine.quantity);
    if (amount === null) {
      throw new Error(`Invoice line ${index + 1} has no valid positive quantity.`);
    }
    const code = normalized(invoiceLine.itemCode);
    const description = normalized(invoiceLine.description);
    if (!code && !description) {
      throw new Error(`Invoice line ${index + 1} has no item code or description to match.`);
    }
    const candidates = available.filter((line) => {
      if (used.has(line.LineNum!)) return false;
      const sapCode = normalized(line.ItemCode);
      const sapDescription = normalized(line.ItemDescription);
      return code ? sapCode === code : sapDescription === description;
    });
    if (candidates.length === 0) {
      throw new Error(`Invoice line ${index + 1} does not exactly match an open ${label} line.`);
    }
    const matches = candidates.filter((line) => amount <= (line.RemainingOpenQuantity ?? 0));
    if (matches.length === 0) {
      throw new Error(`Invoice line ${index + 1} exceeds the ${label}'s remaining open quantity.`);
    }
    const exactQuantity = matches.filter((line) => amount === line.RemainingOpenQuantity);
    const narrowed = exactQuantity.length === 1 ? exactQuantity : matches;
    const match = narrowed[0];
    if (narrowed.length > 1) {
      throw new Error(`Invoice line ${index + 1} matches multiple ${label} lines; select the correct base line in SAP.`);
    }
    used.add(match.LineNum!);
    return {
      BaseType: baseKind === "GRPO" ? 20 : 22,
      BaseEntry: base.DocEntry,
      BaseLine: match.LineNum,
      Quantity: amount,
    };
  });

  return {
    DocObjectCode: "18",
    DocumentSubType: "bod_GSTTaxInvoice",
    DocType: base.DocType === "dDocument_Service" ? "dDocument_Service" : "dDocument_Items",
    CardCode: base.CardCode,
    DocCurrency: base.DocCurrency,
    DocDate: params.postingDate,
    TaxDate: params.invoiceDate,
    NumAtCard: params.invoiceNumber.trim(),
    Comments: `Samrat case ${params.caseId} AP invoice draft`,
    DocumentLines: documentLines,
  };
}

export function buildApInvoiceDraft(params: DraftParams & { grpo: SapGrpo }) {
  return buildBasedApInvoiceDraft({ ...params, base: params.grpo, baseKind: "GRPO" });
}

export function buildPoApInvoiceDraft(params: DraftParams & { po: SapPurchaseOrder }) {
  return buildBasedApInvoiceDraft({ ...params, base: params.po, baseKind: "PO" });
}
