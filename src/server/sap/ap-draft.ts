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

function normalized(value: unknown): string {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function quantity(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function buildApInvoiceDraft(params: {
  grpo: SapGrpo;
  expectedDocEntry: number;
  expectedDocNum: string;
  expectedCardCode: string;
  invoiceVendor: string;
  invoiceNumber: string;
  invoiceLines: InvoiceDraftLine[];
  caseId: string;
}) {
  const { grpo } = params;
  if (
    grpo.DocEntry !== params.expectedDocEntry ||
    String(grpo.DocNum ?? "") !== params.expectedDocNum ||
    grpo.CardCode !== params.expectedCardCode
  ) {
    throw new Error("SAP GRPO identity does not match the selected goods receipt.");
  }
  if (grpo.Cancelled !== "tNO" || grpo.DocumentStatus !== "bost_Open") {
    throw new Error("The selected SAP GRPO is cancelled or no longer open.");
  }
  if (!params.invoiceVendor.trim() || scoreVendorNames(params.invoiceVendor, grpo.CardName) < 0.8) {
    throw new Error("The invoice vendor does not match the selected SAP GRPO vendor.");
  }
  if (!params.invoiceNumber.trim()) {
    throw new Error("A vendor invoice number is required before creating a draft.");
  }
  if (params.invoiceLines.length === 0) {
    throw new Error("No invoice line items were extracted; review the invoice before creating a draft.");
  }

  const available = (grpo.DocumentLines ?? []).filter(
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
    const matches = available.filter((line) => {
      if (used.has(line.LineNum!)) return false;
      const sapCode = normalized(line.ItemCode);
      const sapDescription = normalized(line.ItemDescription);
      return code ? sapCode === code : sapDescription === description;
    });
    const match = matches[0];
    if (!match || match.LineNum === undefined) {
      throw new Error(`Invoice line ${index + 1} does not exactly match an open GRPO line.`);
    }
    if (matches.length > 1) {
      throw new Error(`Invoice line ${index + 1} matches multiple GRPO lines; select the correct base line in SAP.`);
    }
    if (amount > (match.RemainingOpenQuantity ?? 0)) {
      throw new Error(`Invoice line ${index + 1} exceeds the GRPO's remaining open quantity.`);
    }
    used.add(match.LineNum);
    return {
      BaseType: 20,
      BaseEntry: grpo.DocEntry,
      BaseLine: match.LineNum,
      Quantity: amount,
    };
  });

  return {
    DocObjectCode: "18",
    DocumentSubType: "bod_GSTTaxInvoice",
    DocType: "dDocument_Items",
    CardCode: grpo.CardCode,
    NumAtCard: params.invoiceNumber.trim(),
    Comments: `Samrat case ${params.caseId} AP invoice draft`,
    DocumentLines: documentLines,
  };
}
