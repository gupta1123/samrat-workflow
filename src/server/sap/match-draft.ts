// Builds the SAP A/P Invoice draft from a "ready" match, and creates it with the
// same posting-date and numbering-series fallbacks the single-document flow uses.
// The payload builder is pure; the creator takes the Service Layer client.

import type { PlannedPayload } from "@/lib/sap-match/types";
import { sapTestPostingDateCandidates } from "./dates";
import type { SapMatchDocument } from "./service-layer";

export class MatchDraftError extends Error {}

type BaseDocument = SapMatchDocument & { DocType?: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function lineOf(document: BaseDocument | undefined, lineNum: number) {
  return (document?.DocumentLines ?? []).find(
    (line) => record(line).LineNum === lineNum,
  );
}

/**
 * @param bases the SAP base documents (receipts or POs) keyed by "<baseType>:<docEntry>",
 *   re-read from SAP immediately before creating the draft.
 */
export function buildMatchedDraftPayload(params: {
  caseId: string;
  plan: PlannedPayload;
  bases: Map<string, BaseDocument>;
  freightExpenseCode: number | null;
  invoiceRates?: Array<number | null>;
}) {
  const { plan, bases } = params;
  if (!plan.lines.length)
    throw new MatchDraftError("There is nothing to put on the SAP invoice.");

  const documents = [...bases.values()];
  const currencies = new Set(
    documents.map((document) => String(document.DocCurrency ?? "")),
  );
  if (currencies.size !== 1 || ![...currencies][0]) {
    throw new MatchDraftError(
      "The SAP documents behind this invoice use different currencies, or none. Review them in SAP.",
    );
  }
  const currency = [...currencies][0];

  const serviceLines = plan.lines.filter(
    (line) => line.baseType === 22 && line.lineTotal !== null,
  );
  if (serviceLines.length && serviceLines.length !== plan.lines.length) {
    throw new MatchDraftError(
      "This invoice mixes stock and service lines. Raise them as separate invoices.",
    );
  }
  const isService = serviceLines.length > 0;

  const documentLines = plan.lines.map((line) => {
    const base = bases.get(`${line.baseType}:${line.baseEntry}`);
    if (!base)
      throw new MatchDraftError("A SAP base document could not be read again.");
    if (base.CardCode !== plan.cardCode) {
      throw new MatchDraftError(
        `SAP document ${line.baseDocNum} belongs to a different vendor than this invoice.`,
      );
    }
    const baseLine = record(lineOf(base, line.baseLine));
    if (
      baseLine.LineStatus !== "bost_Open" &&
      baseLine.LineStatus !== undefined
    ) {
      throw new MatchDraftError(
        `Line ${line.baseLine} of SAP document ${line.baseDocNum} is no longer open.`,
      );
    }
    if (isService) {
      if (base.DocType !== "dDocument_Service") {
        throw new MatchDraftError(
          `SAP purchase order ${line.baseDocNum} bills services by item, which this integration does not support yet.`,
        );
      }
      return {
        BaseType: line.baseType,
        BaseEntry: line.baseEntry,
        BaseLine: line.baseLine,
        LineTotal: line.lineTotal,
      };
    }
    const open = Number(baseLine.RemainingOpenQuantity);
    if (!Number.isFinite(open) || line.quantity > open + 0.0005) {
      throw new MatchDraftError(
        `SAP document ${line.baseDocNum} no longer has ${line.quantity} open. Refresh the match.`,
      );
    }
    const unitPrice =
      line.unitPrice ??
      params.invoiceRates?.[line.invoiceLineIndex] ??
      baseLine.Price;
    if (
      typeof unitPrice !== "number" ||
      !Number.isFinite(unitPrice) ||
      unitPrice < 0
    ) {
      throw new MatchDraftError(
        `Invoice line ${line.invoiceLineIndex + 1} has no valid unit price. Review it before creating a draft.`,
      );
    }
    return {
      BaseType: line.baseType,
      BaseEntry: line.baseEntry,
      BaseLine: line.baseLine,
      Quantity: line.quantity,
      UnitPrice: unitPrice,
    };
  });

  const payload: Record<string, unknown> = {
    DocObjectCode: "18",
    DocumentSubType: "bod_GSTTaxInvoice",
    DocType: isService ? "dDocument_Service" : "dDocument_Items",
    CardCode: plan.cardCode,
    DocCurrency: currency,
    DocDate: plan.docDate,
    TaxDate: plan.taxDate,
    NumAtCard: plan.numAtCard,
    Comments: `Samrat case ${params.caseId} AP invoice draft`,
    DocumentLines: documentLines,
  };

  if (plan.freightExpense && plan.freightExpense > 0) {
    if (!params.freightExpenseCode) {
      throw new MatchDraftError(
        "Freight is booked as a freight charge, but SAP_FREIGHT_EXPENSE_CODE is not configured on the server.",
      );
    }
    const first = plan.lines[0];
    const taxCode = record(
      lineOf(bases.get(`${first.baseType}:${first.baseEntry}`), first.baseLine),
    ).TaxCode;
    payload.DocumentAdditionalExpenses = [
      {
        ExpenseCode: params.freightExpenseCode,
        LineTotal: plan.freightExpense,
        ...(typeof taxCode === "string" && taxCode ? { TaxCode: taxCode } : {}),
      },
    ];
  }
  return { payload, currency };
}

type DraftClient = {
  getAdminCurrencies: () => Promise<{
    LocalCurrency?: string;
    SystemCurrency?: string;
  }>;
  getCurrencyRate: (currency: string, date: string) => Promise<number>;
  listApInvoicePostingDates: (onOrBefore: string) => Promise<string[]>;
  resolveGstApInvoiceSeries: (
    postingDate: string,
    branchId: number | null | undefined,
    baseSeries: number | undefined,
  ) => Promise<number | null>;
  createDraft: (
    payload: Record<string, unknown>,
  ) => Promise<{ DocEntry?: number; DocNum?: number; CardCode?: string }>;
};

export async function createMatchedDraft(
  client: DraftClient,
  params: {
    payload: Record<string, unknown>;
    currency: string;
    postingDate: string;
    taxDate: string;
    baseDocument: BaseDocument & {
      Series?: number;
      BPL_IDAssignedToInvoice?: number | null;
    };
  },
) {
  const { baseDocument } = params;
  let postingDate = params.postingDate;
  let usedHistoricalPostingDate = false;

  const currencies = await client.getAdminCurrencies();
  if (!currencies.LocalCurrency || !currencies.SystemCurrency) {
    throw new MatchDraftError(
      "SAP Test did not return its local and system currencies; no draft was created.",
    );
  }
  const required = [currencies.SystemCurrency, params.currency].filter(
    (currency) => currency && currency !== currencies.LocalCurrency,
  );
  const missingRatesFor = async (date: string) => {
    const missing: string[] = [];
    for (const currency of new Set(required)) {
      try {
        await client.getCurrencyRate(currency, date);
      } catch (error) {
        if (
          /update the exchange rate|no valid .* exchange rate/i.test(
            String(error),
          )
        ) {
          missing.push(currency);
          continue;
        }
        throw error;
      }
    }
    return missing;
  };

  const missing = await missingRatesFor(postingDate);
  if (missing.length) {
    // The historical fallback only applies when booking on the vendor's invoice date.
    const canFallBack = postingDate === params.taxDate;
    let compatible: string | null = null;
    if (canFallBack) {
      const existing = await client.listApInvoicePostingDates(params.taxDate);
      const candidates = sapTestPostingDateCandidates({
        invoiceDate: params.taxDate,
        baseDocumentDate: baseDocument.DocDate,
        existingInvoiceDates: [...existing, baseDocument.DocDate],
      }).slice(0, 12);
      for (const candidate of candidates) {
        if ((await missingRatesFor(candidate)).length === 0) {
          compatible = candidate;
          break;
        }
      }
    }
    if (!compatible) {
      throw new MatchDraftError(
        `SAP Test has no ${missing.join("/")} reporting-currency rate for ${postingDate}, and no compatible posting date was found. No draft was created.`,
      );
    }
    postingDate = compatible;
    usedHistoricalPostingDate = true;
  }

  const payload = { ...params.payload, DocDate: postingDate };
  let series: number | null = null;
  let created;
  try {
    created = await client.createDraft(payload);
  } catch (error) {
    if (!/10000521|define the numbering series/i.test(String(error)))
      throw error;
    series = await client.resolveGstApInvoiceSeries(
      postingDate,
      baseDocument.BPL_IDAssignedToInvoice,
      baseDocument.Series,
    );
    if (!series) {
      throw new MatchDraftError(
        `SAP Test has no usable GST A/P Invoice numbering series for ${postingDate}. No draft was created.`,
      );
    }
    try {
      created = await client.createDraft({ ...payload, Series: series });
    } catch (retryError) {
      if (/10000521|define the numbering series/i.test(String(retryError))) {
        throw new MatchDraftError(
          `SAP Test rejected its existing GST A/P Invoice series ${series} for posting date ${postingDate}. No draft was created.`,
        );
      }
      throw retryError;
    }
  }
  return { created, postingDate, usedHistoricalPostingDate, series };
}
