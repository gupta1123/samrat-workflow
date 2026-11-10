// Builds the SAP A/P Invoice draft from a "ready" match, and creates it with the
// same posting-date and numbering-series fallbacks the single-document flow uses.
// The payload builder is pure; the creator takes the Service Layer client.

import type { MatchInvoiceLine, PlannedPayload } from "@/lib/sap-match/types";
import { sapTestPostingDateCandidates } from "./dates";
import type { SapMatchDocument } from "./service-layer";
import { serviceOpenBalance } from "@/lib/sap-service-balance";

export class MatchDraftError extends Error {
  constructor(
    message: string,
    public numberingSeriesRequired = false,
  ) {
    super(message);
  }
}

type BaseDocument = SapMatchDocument & { DocType?: string };
type ItemDraftLine = {
  BaseType: number;
  BaseEntry: number;
  BaseLine: number;
  Quantity: number;
  UnitPrice: number;
};
type ServiceDraftLine = {
  BaseType: number;
  BaseEntry: number;
  BaseLine: number;
  LineTotal: number;
  AccountCode: string;
};
type DraftBaseLine = ItemDraftLine | ServiceDraftLine;

/** SAP accepts a base line only once. Keep every source row in the audit plan;
 * combine only the SAP representation, with proof that printed amounts survive. */
function consolidateDraftBaseLines(
  lines: DraftBaseLine[],
  plan: PlannedPayload,
  invoiceLines: MatchInvoiceLine[] = [],
) {
  const groups = new Map<
    string,
    Array<{ line: DraftBaseLine; invoiceLineIndex: number }>
  >();
  lines.forEach((line, index) => {
    const key = `${line.BaseType}:${line.BaseEntry}:${line.BaseLine}`;
    const group = groups.get(key) ?? [];
    group.push({ line, invoiceLineIndex: plan.lines[index].invoiceLineIndex });
    groups.set(key, group);
  });
  const sourceByIndex = new Map(invoiceLines.map((line) => [line.index, line]));
  const documentLines: DraftBaseLine[] = [];
  const sourceLineGroups: Array<{
    draftLineIndex: number;
    invoiceLineIndexes: number[];
    baseType: number;
    baseEntry: number;
    baseLine: number;
  }> = [];
  const minor = (value: number, decimals: number) => {
    const scaled = value * 10 ** decimals;
    if (!Number.isFinite(scaled) || Math.abs(scaled) > Number.MAX_SAFE_INTEGER)
      throw new MatchDraftError(
        "The invoice amount exceeds safe precision for SAP line consolidation.",
      );
    return Math.round(
      scaled + Math.min(1e-7, Number.EPSILON * Math.max(1, Math.abs(scaled))),
    );
  };
  for (const group of groups.values()) {
    const first = group[0].line;
    let combined: DraftBaseLine = first;
    if (group.length > 1 && "LineTotal" in first) {
      if (
        !group.every(
          ({ line }) =>
            "LineTotal" in line && line.AccountCode === first.AccountCode,
        )
      )
        throw new MatchDraftError(
          "Repeated SAP base lines have incompatible expense accounts.",
        );
      combined = {
        ...first,
        LineTotal:
          minor(
            group.reduce(
              (sum, { line }) =>
                sum + ("LineTotal" in line ? line.LineTotal : 0),
              0,
            ),
            6,
          ) / 1e6,
      };
    } else if (group.length > 1) {
      const observed = group.map(({ line, invoiceLineIndex }) => {
        const source = sourceByIndex.get(invoiceLineIndex);
        if (
          !("Quantity" in line) ||
          !Number.isFinite(line.Quantity) ||
          line.Quantity <= 0 ||
          !source ||
          source.quantity === null ||
          source.quantity <= 0 ||
          source.rate === null ||
          source.amount === null ||
          source.amount < 0 ||
          !Number.isInteger(source.amountDecimals) ||
          source.amountDecimals! < 0 ||
          source.amountDecimals! > 6 ||
          source.rate !== line.UnitPrice ||
          line.Quantity > source.quantity + 0.0000005
        )
          throw new MatchDraftError(
            "Repeated SAP receipt lines need their original printed quantities, rates, amounts and amount precision. Re-check the case before creating a draft; no price will be invented.",
          );
        const decimals = source.amountDecimals!;
        if (
          minor(source.quantity * source.rate, decimals) !==
          minor(source.amount, decimals)
        )
          throw new MatchDraftError(
            "The printed invoice quantity and unit price do not reproduce its row amount. Review the source before combining repeated SAP receipt lines.",
          );
        const amount =
          Math.abs(line.Quantity - source.quantity) < 0.0000005
            ? source.amount
            : minor(line.Quantity * source.rate, decimals) / 10 ** decimals;
        return { line, decimals, amount };
      });
      const quantity =
        Math.round(
          observed.reduce((sum, row) => sum + row.line.Quantity, 0) * 1e6,
        ) / 1e6;
      const decimals = Math.max(...observed.map((row) => row.decimals));
      const expected = observed.reduce(
        (sum, row) => sum + minor(row.amount, decimals),
        0,
      );
      const prices = [
        ...new Set(observed.map((row) => row.line.UnitPrice)),
      ].filter(
        (price) =>
          observed.every(
            (row) =>
              minor(row.line.Quantity * price, row.decimals) ===
              minor(row.amount, row.decimals),
          ) && minor(quantity * price, decimals) === expected,
      );
      if (prices.length !== 1)
        throw new MatchDraftError(
          "SAP needs one row per receipt line, but these invoice rows cannot be combined at one unambiguous printed unit price while preserving every row amount. Review the invoice or split the receipt in SAP; no average price was substituted.",
        );
      combined = {
        ...observed[0].line,
        Quantity: quantity,
        UnitPrice: prices[0],
      };
    }
    sourceLineGroups.push({
      draftLineIndex: documentLines.length,
      invoiceLineIndexes: [
        ...new Set(group.map((row) => row.invoiceLineIndex)),
      ],
      baseType: first.BaseType,
      baseEntry: first.BaseEntry,
      baseLine: first.BaseLine,
    });
    documentLines.push(combined);
  }
  return { documentLines, sourceLineGroups };
}

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

/** Item-based PO invoicing is allowed only for SAP-confirmed non-stock items.
 * Re-read this flag immediately before draft creation; a saved review is not
 * permission to bypass stock receipt checks after SAP master data changes.
 */
export async function revalidateNonStockPoItems(
  plan: PlannedPayload,
  bases: Map<string, BaseDocument>,
  readItem: (
    code: string,
  ) => Promise<{ ItemCode?: string; InventoryItem?: string }>,
) {
  const codes = new Set<string>();
  for (const line of plan.lines) {
    if (line.baseType !== 22) continue;
    const base = bases.get(`22:${line.baseEntry}`);
    if (base?.DocType === "dDocument_Service") continue;
    const raw = record(lineOf(base, line.baseLine));
    if (!line.itemCode || raw.ItemCode !== line.itemCode)
      throw new MatchDraftError(
        "The selected PO item changed. Re-check and confirm the PO line again.",
      );
    codes.add(line.itemCode);
  }
  for (const code of codes) {
    const item = await readItem(code);
    if (item.ItemCode !== code || item.InventoryItem !== "tNO")
      throw new MatchDraftError(
        "SAP no longer confirms the selected PO item as non-stock. Re-check; stock items require the GRPO flow.",
      );
  }
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
  invoiceLines?: MatchInvoiceLine[];
  localCurrency?: string;
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
    (line) =>
      bases.get(`${line.baseType}:${line.baseEntry}`)?.DocType ===
      "dDocument_Service",
  );
  if (serviceLines.length && serviceLines.length !== plan.lines.length) {
    throw new MatchDraftError(
      "This invoice mixes stock and service lines. Raise them as separate invoices.",
    );
  }
  const isService = serviceLines.length > 0;
  const reservedQuantities = new Map<string, number>();
  const reservedAmounts = new Map<string, number>();

  const rawDocumentLines: DraftBaseLine[] = plan.lines.map((line) => {
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
      base.DocType !== "dDocument_Service" &&
      baseLine.ItemCode != null &&
      baseLine.ItemCode !== line.itemCode
    )
      throw new MatchDraftError(
        `The item on SAP document ${line.baseDocNum}, line ${line.baseLine} changed. Re-check the match.`,
      );
    if (
      (line.documentType &&
        base.DocType &&
        line.documentType !== base.DocType) ||
      (!line.documentType &&
        line.lineTotal !== null &&
        base.DocType !== "dDocument_Service")
    )
      throw new MatchDraftError(
        `SAP purchase order ${line.baseDocNum} bills services by item. Re-check the invoice against its actual SAP document type.`,
      );
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
      const available = serviceOpenBalance(
        baseLine,
        base.DocCurrency,
        params.localCurrency,
      );
      const total =
        (reservedAmounts.get(`${line.baseEntry}:${line.baseLine}`) ?? 0) +
        (line.lineTotal ?? 0);
      if (
        available === null ||
        !Number.isFinite(available) ||
        !Number.isFinite(line.lineTotal) ||
        line.lineTotal === null ||
        line.lineTotal <= 0 ||
        total > (available ?? 0) + 0.005
      )
        throw new MatchDraftError(
          `Service PO ${line.baseDocNum} does not have enough verified open value for the selected invoice lines. Re-check the PO.`,
        );
      if (typeof baseLine.AccountCode !== "string" || !baseLine.AccountCode)
        throw new MatchDraftError(
          `Service PO ${line.baseDocNum} has no SAP expense account.`,
        );
      reservedAmounts.set(`${line.baseEntry}:${line.baseLine}`, total);
      return {
        BaseType: line.baseType,
        BaseEntry: line.baseEntry,
        BaseLine: line.baseLine,
        LineTotal: line.lineTotal,
        AccountCode: baseLine.AccountCode,
      };
    }
    const open = Number(baseLine.RemainingOpenQuantity);
    const baseLineKey = `${line.baseType}:${line.baseEntry}:${line.baseLine}`;
    const totalReserved =
      (reservedQuantities.get(baseLineKey) ?? 0) + line.quantity;
    if (!Number.isFinite(open) || totalReserved > open + 0.0005) {
      throw new MatchDraftError(
        `SAP document ${line.baseDocNum} no longer has ${totalReserved} open across the selected invoice lines. Refresh the match.`,
      );
    }
    reservedQuantities.set(baseLineKey, totalReserved);
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
  const { documentLines, sourceLineGroups } = consolidateDraftBaseLines(
    rawDocumentLines,
    plan,
    params.invoiceLines,
  );

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
  return { payload, currency, sourceLineGroups };
}

type DraftClient = {
  listGstApInvoiceSeries?: (
    postingDate: string,
    branchId?: number | null,
  ) => Promise<Array<{ value: string; label: string }>>;
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
    numberingSeries?: number;
    baseDocument: BaseDocument & {
      Series?: number;
      BPL_IDAssignedToInvoice?: number | null;
    };
  },
) {
  const { baseDocument } = params;
  let postingDate = params.postingDate;
  let usedHistoricalPostingDate = false;
  if (
    params.numberingSeries !== undefined &&
    (!Number.isSafeInteger(params.numberingSeries) ||
      params.numberingSeries <= 0)
  )
    throw new MatchDraftError("Choose a numbering series from SAP.", true);

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
    if (params.numberingSeries !== undefined)
      throw new MatchDraftError(
        `SAP has no required reporting-currency rate for ${postingDate}. Ask the SAP team to add it; the posting date was not changed.`,
      );
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

  let payload: Record<string, unknown> = {
    ...params.payload,
    DocDate: postingDate,
  };
  let series: number | null =
    typeof payload.Series === "number" ? payload.Series : null;
  if (params.numberingSeries !== undefined) {
    if (!client.listGstApInvoiceSeries)
      throw new MatchDraftError(
        "SAP numbering series could not be validated.",
        true,
      );
    const options = await client.listGstApInvoiceSeries(
      postingDate,
      baseDocument.BPL_IDAssignedToInvoice,
    );
    if (
      !options.some((option) => option.value === String(params.numberingSeries))
    )
      throw new MatchDraftError(
        "That numbering series is no longer available for this posting date and branch. Reload the choices or contact your SAP administrator.",
        true,
      );
    series = params.numberingSeries;
    payload = { ...payload, Series: series };
  }
  let created;
  try {
    created = await client.createDraft(payload);
  } catch (error) {
    if (!/10000521|define the numbering series/i.test(String(error)))
      throw error;
    if (series !== null) {
      throw new MatchDraftError(
        `SAP rejected numbering series ${series} for posting date ${postingDate}. Choose another SAP series or contact your SAP administrator; no alternative series was substituted.`,
        true,
      );
    }
    series = await client.resolveGstApInvoiceSeries(
      postingDate,
      baseDocument.BPL_IDAssignedToInvoice,
      baseDocument.Series,
    );
    if (!series) {
      throw new MatchDraftError(
        `SAP Test has no usable GST A/P Invoice numbering series for ${postingDate}. No draft was created.`,
        true,
      );
    }
    try {
      payload = { ...payload, Series: series };
      created = await client.createDraft(payload);
    } catch (retryError) {
      if (/10000521|define the numbering series/i.test(String(retryError))) {
        throw new MatchDraftError(
          `SAP Test rejected its existing GST A/P Invoice series ${series} for posting date ${postingDate}. No draft was created.`,
          true,
        );
      }
      throw retryError;
    }
  }
  return {
    created,
    postingDate,
    usedHistoricalPostingDate,
    series,
    submittedPayload: payload,
  };
}
