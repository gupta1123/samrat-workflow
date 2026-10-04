import { sapFetch } from "./http";
import type { SapGrpo } from "./ap-draft";
import {
  indianFinancialYear,
  selectConfiguredGstApInvoiceSeries,
  selectExistingGstApInvoiceSeries,
  type SapNumberedApInvoice,
  type SapNumberingSeries,
} from "./numbering-series";
import type { SapWithholdingTaxRow } from "./draft-total";
import { sapDocumentNumber } from "@/lib/sap-exact-po-match";
import { selectOpenGrposBasedOnPurchaseOrders } from "@/lib/sap-grpo-relations";
import { readODataCollection } from "./odata-pagination";
import { businessPartnerReadPath, type BusinessPartnerQuery } from "@/lib/sap-business-partners";

type SapDraftResponse = {
  DocEntry?: number;
  DocNum?: number;
  DocDate?: string;
  TaxDate?: string;
  CardCode?: string;
  CardName?: string;
  NumAtCard?: string | null;
  DocTotal?: number;
  DocCurrency?: string;
  Comments?: string;
  DocObjectCode?: string;
  WithholdingTaxDataCollection?: SapWithholdingTaxRow[];
  DocumentLines?: Array<{
    LineNum?: number;
    ItemCode?: string;
    ItemDescription?: string;
    Quantity?: number;
    BaseType?: number;
    BaseEntry?: number | null;
    BaseLine?: number | null;
  }>;
};

type SapItemInventoryState = {
  ItemCode?: string;
  InventoryItem?: string;
};

export type SapSupplierRow = {
  CardCode: string;
  CardName: string;
  BPAddresses?: Array<{ GSTIN?: string | null }>;
};
export type SapItemRow = {
  ItemCode: string;
  ItemName?: string;
  InventoryItem?: string;
};
/** A purchase order or goods receipt as returned for matching, with all its lines. */
export type SapMatchDocument = Record<string, unknown> & {
  DocEntry?: number;
  DocNum?: number;
  DocDate?: string;
  CardCode?: string;
  CardName?: string;
  NumAtCard?: string | null;
  Comments?: string | null;
  BPL_IDAssignedToInvoice?: number | null;
  DocCurrency?: string;
  DocumentLines?: Array<Record<string, unknown>>;
};

export type SapReadDocument = Omit<SapGrpo, "DocumentLines"> & {
  NumAtCard?: string | null;
  DocTotal?: number;
  DocumentLines?: Array<
    NonNullable<SapGrpo["DocumentLines"]>[number] & {
      Price?: number;
      BaseType?: number;
      BaseEntry?: number | null;
      BaseLine?: number | null;
    }
  >;
};

export type SapInspectorServiceLayerDataset = "po" | "grpo" | "ap-invoice";

function testConfig() {
  const baseUrl = (process.env.SAP_SL_TEST_BASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  const company = (process.env.SAP_SL_TEST_COMPANY_DB ?? "").trim();
  const username = (process.env.SAP_SL_TEST_USERNAME ?? "").trim();
  const password = (process.env.SAP_SL_TEST_PASSWORD ?? "").trim();
  if (!baseUrl || !company || !username || !password) {
    throw new Error("SAP Test Service Layer is not configured on the server.");
  }
  if (!baseUrl.startsWith("https://") || !baseUrl.endsWith("/b1s/v1")) {
    throw new Error(
      "SAP Test Service Layer URL must be an HTTPS /b1s/v1 endpoint.",
    );
  }
  return { baseUrl, company, username, password };
}

export async function withTestServiceLayer<T>(
  action: (client: {
    listOpenGrpos: () => Promise<SapGrpo[]>;
    listOpenGrposForPurchaseOrders: (
      purchaseOrders: SapReadDocument[],
    ) => Promise<SapGrpo[]>;
    getGrpo: (docEntry: number) => Promise<SapGrpo>;
    listGrposByDocNum: (docNum: number) => Promise<SapReadDocument[]>;
    getPurchaseOrder: (docEntry: number) => Promise<SapReadDocument>;
    getItemInventoryState: (itemCode: string) => Promise<SapItemInventoryState>;
    listPurchaseOrdersByDocNum: (docNum: number) => Promise<SapReadDocument[]>;
    getAdminCurrencies: () => Promise<{
      LocalCurrency?: string;
      SystemCurrency?: string;
    }>;
    getCurrencyRate: (currency: string, date: string) => Promise<number>;
    listInvoicesByAmount: (
      cardCode: string,
      amount: number,
    ) => Promise<SapReadDocument[]>;
    findInvoiceByReference: (
      cardCode: string,
      vendorReference: string,
    ) => Promise<SapReadDocument | null>;
    listRecentInvoicesForVendor: (
      cardCode: string,
    ) => Promise<Record<string, unknown>[]>;
    findDraft: (comment: string) => Promise<SapDraftResponse | null>;
    listSuppliers: () => Promise<SapSupplierRow[]>;
    searchSuppliers: (query: string) => Promise<SapSupplierRow[]>;
    getSupplier: (cardCode: string) => Promise<SapSupplierRow | null>;
    listBusinessPartnersPage: (query: BusinessPartnerQuery) => Promise<Record<string, unknown>[]>;
    listOpenReceiptDocumentsForVendor: (
      cardCode: string,
    ) => Promise<SapMatchDocument[]>;
    findOpenReceiptDocumentsForInvoice: (input: {
      cardCode: string;
      invoiceNumber: string;
      eWayBill: string | null;
      lorryReceipt: string | null;
      vehicles: string[];
      invoiceRefField?: string;
      eWayBillField?: string;
      lorryReceiptField?: string;
      vehicleField?: string;
    }) => Promise<SapMatchDocument[]>;
    listOpenPurchaseOrdersForVendor: (
      cardCode: string,
    ) => Promise<SapMatchDocument[]>;
    listPurchaseOrdersByEntries: (
      entries: number[],
    ) => Promise<SapMatchDocument[]>;
    listItemsByCodes: (codes: string[]) => Promise<SapItemRow[]>;
    searchItems: (query: string) => Promise<SapItemRow[]>;
    findDraftByVendorReference: (
      cardCode: string,
      vendorReference: string,
    ) => Promise<SapDraftResponse | null>;
    listApInvoicePostingDates: (onOrBefore: string) => Promise<string[]>;
    resolveGstApInvoiceSeries: (
      postingDate: string,
      branchId: number | null | undefined,
      baseSeries: number | undefined,
    ) => Promise<number | null>;
    createDraft: (
      payload: Record<string, unknown>,
    ) => Promise<SapDraftResponse>;
    getDraft: (docEntry: number) => Promise<SapDraftResponse>;
    updateDraft: (
      docEntry: number,
      payload: Record<string, unknown>,
    ) => Promise<void>;
    finalizeDraft: (docEntry: number) => Promise<Record<string, unknown>>;
    getUserField: (
      tableName: string,
      description: string,
    ) => Promise<Record<string, unknown> | null>;
    getUserFields: (
      tableName: string,
      description: string,
    ) => Promise<Record<string, unknown>[]>;
    listInspectorDocuments: (
      dataset: SapInspectorServiceLayerDataset,
      max: number,
      additionalHeaderFields?: string[],
    ) => Promise<Record<string, unknown>[]>;
  }) => Promise<T>,
): Promise<T> {
  const config = testConfig();
  let cookie = "";
  async function request(path: string, init: RequestInit = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await sapFetch(`${config.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
          ...init.headers,
        },
        signal: controller.signal,
        cache: "no-store",
      });
      const body = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!response.ok) {
        const sapError = body.error as
          { message?: { value?: string } } | undefined;
        const detail = sapError?.message?.value;
        throw new Error(
          `SAP Service Layer returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}.`,
        );
      }
      return { response, body };
    } finally {
      clearTimeout(timer);
    }
  }

  const login = await request("/Login", {
    method: "POST",
    body: JSON.stringify({
      CompanyDB: config.company,
      UserName: config.username,
      Password: config.password,
    }),
  });
  const sessionId = login.body.SessionId;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("SAP Service Layer login did not return a session.");
  }
  const routeId = login.response.headers
    .get("set-cookie")
    ?.match(/ROUTEID=[^;\s,]+/)?.[0];
  cookie = [`B1SESSION=${sessionId}`, routeId].filter(Boolean).join("; ");

  function seriesRows(body: Record<string, unknown>): SapNumberingSeries[] {
    if (Array.isArray(body.value)) return body.value as SapNumberingSeries[];
    const collection = body.SeriesCollection;
    if (Array.isArray(collection)) return collection as SapNumberingSeries[];
    if (collection && typeof collection === "object") {
      const nested = (collection as { Series?: unknown }).Series;
      if (Array.isArray(nested)) return nested as SapNumberingSeries[];
      if (nested && typeof nested === "object")
        return [nested as SapNumberingSeries];
    }
    if (body.Series && typeof body.Series === "object") {
      return [body.Series as SapNumberingSeries];
    }
    return Number.isInteger(body.Series) ? [body as SapNumberingSeries] : [];
  }

  async function pageAll<T>(path: string, max: number): Promise<T[]> {
    try {
      return await readODataCollection<T>({
        initialPath: path,
        baseUrl: config.baseUrl,
        max,
        read: async (nextPath) => (await request(nextPath)).body,
      });
    } catch (error) {
      const entity = path.split("?", 1)[0];
      throw new Error(
        `${entity} paging failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function collectionOnce<T>(path: string, max: number): Promise<T[]> {
    const separator = path.includes("?") ? "&" : "?";
    const { body } = await request(`${path}${separator}$top=${max}`);
    return Array.isArray(body.value) ? (body.value as T[]).slice(0, max) : [];
  }

  async function listOpenGrposByFilter(filter: string): Promise<SapGrpo[]> {
    const rows = await pageAll<SapGrpo>(
      "/PurchaseDeliveryNotes?$select=DocEntry,DocNum,CardCode,CardName,DocumentStatus,Cancelled,DocumentLines" +
        `&$filter=${encodeURIComponent(filter)}` +
        "&$orderby=DocEntry%20asc",
      5000,
    );
    const seenDocEntries = new Set<number>();
    return rows.filter((document) => {
      if (
        typeof document.DocEntry !== "number" ||
        seenDocEntries.has(document.DocEntry)
      ) {
        return false;
      }
      seenDocEntries.add(document.DocEntry);
      return true;
    });
  }

  try {
    return await action({
      async listOpenGrpos() {
        const rows = await listOpenGrposByFilter(
          "DocumentStatus eq 'bost_Open'",
        );
        return rows.filter((row) => row.Cancelled === "tNO");
      },
      async listOpenGrposForPurchaseOrders(purchaseOrders) {
        const cardCodes = Array.from(
          new Set(
            purchaseOrders.flatMap((purchaseOrder) =>
              typeof purchaseOrder.CardCode === "string" &&
              purchaseOrder.CardCode.trim()
                ? [purchaseOrder.CardCode]
                : [],
            ),
          ),
        );
        const candidates: SapGrpo[] = [];
        for (const cardCode of cardCodes) {
          const escapedCardCode = cardCode.replaceAll("'", "''");
          candidates.push(
            ...(await listOpenGrposByFilter(
              `DocumentStatus eq 'bost_Open' and CardCode eq '${escapedCardCode}'`,
            )),
          );
        }
        return selectOpenGrposBasedOnPurchaseOrders(candidates, purchaseOrders);
      },
      async getGrpo(docEntry) {
        const { body } = await request(`/PurchaseDeliveryNotes(${docEntry})`);
        return body as SapGrpo;
      },
      async listGrposByDocNum(docNum) {
        const filter = encodeURIComponent(`DocNum eq ${docNum}`);
        const { body } = await request(
          `/PurchaseDeliveryNotes?$select=DocEntry,DocNum,CardCode,CardName,NumAtCard,DocTotal,DocumentStatus,Cancelled,DocumentLines&$filter=${filter}&$top=100`,
        );
        return Array.isArray(body.value)
          ? (body.value as SapReadDocument[])
          : [];
      },
      async getPurchaseOrder(docEntry) {
        const { body } = await request(`/PurchaseOrders(${docEntry})`);
        return body as SapReadDocument;
      },
      async getItemInventoryState(itemCode) {
        const escapedItemCode = itemCode.replaceAll("'", "''");
        const { body } = await request(
          `/Items('${escapedItemCode}')?$select=ItemCode,InventoryItem`,
        );
        return body as SapItemInventoryState;
      },
      async listPurchaseOrdersByDocNum(docNum) {
        const filter = encodeURIComponent(`DocNum eq ${docNum}`);
        const { body } = await request(
          `/PurchaseOrders?$select=DocEntry,DocNum,CardCode,CardName,DocumentStatus,Cancelled&$filter=${filter}&$top=100`,
        );
        return Array.isArray(body.value)
          ? (body.value as SapReadDocument[])
          : [];
      },
      async getAdminCurrencies() {
        const { body } = await request("/CompanyService_GetAdminInfo", {
          method: "POST",
          body: "{}",
        });
        return {
          LocalCurrency:
            typeof body.LocalCurrency === "string"
              ? body.LocalCurrency
              : undefined,
          SystemCurrency:
            typeof body.SystemCurrency === "string"
              ? body.SystemCurrency
              : undefined,
        };
      },
      async getCurrencyRate(currency, date) {
        const { body } = await request("/SBOBobService_GetCurrencyRate", {
          method: "POST",
          body: JSON.stringify({
            Currency: currency,
            Date: date.replaceAll("-", ""),
          }),
        });
        const rate = Number(body);
        if (!Number.isFinite(rate) || rate <= 0) {
          throw new Error(
            `SAP has no valid ${currency} exchange rate for ${date}.`,
          );
        }
        return rate;
      },
      async listInvoicesByAmount(cardCode, amount) {
        // SAP rounds document totals in some branches, so allow up to two rupees.
        const tolerance = Math.max(2, amount * 0.00001);
        const filter = encodeURIComponent(
          `CardCode eq '${cardCode.replace(/'/g, "''")}' and DocTotal ge ${Math.max(0, amount - tolerance)} and DocTotal le ${amount + tolerance}`,
        );
        const { body } = await request(
          `/PurchaseInvoices?$select=DocEntry,DocNum,CardCode,CardName,NumAtCard,DocTotal,DocumentStatus,Cancelled,DocumentLines&$filter=${filter}&$top=100`,
        );
        return Array.isArray(body.value)
          ? (body.value as SapReadDocument[])
          : [];
      },
      async findInvoiceByReference(cardCode, vendorReference) {
        const filter = encodeURIComponent(
          `CardCode eq '${cardCode.replace(/'/g, "''")}' and NumAtCard eq '${vendorReference.replace(/'/g, "''")}'`,
        );
        const { body } = await request(
          `/PurchaseInvoices?$select=DocEntry,DocNum,CardCode,NumAtCard,Cancelled&$filter=${filter}&$top=10`,
        );
        const rows = Array.isArray(body.value)
          ? (body.value as SapReadDocument[])
          : [];
        return rows.find((row) => row.Cancelled === "tNO") ?? null;
      },
      async listRecentInvoicesForVendor(cardCode) {
        const filter = encodeURIComponent(
          `CardCode eq '${cardCode.replaceAll("'", "''")}' and Cancelled eq 'tNO'`,
        );
        const { body } = await request(
          `/PurchaseInvoices?$filter=${filter}&$orderby=DocEntry%20desc&$top=20`,
        );
        return Array.isArray(body.value)
          ? (body.value as Record<string, unknown>[])
          : [];
      },
      async findDraft(comment) {
        const filter = encodeURIComponent(
          `Comments eq '${comment.replace(/'/g, "''")}'`,
        );
        const { body } = await request(`/Drafts?$filter=${filter}&$top=5`);
        const rows = Array.isArray(body.value)
          ? (body.value as SapDraftResponse[])
          : [];
        return (
          rows.find(
            (row) =>
              row.Comments === comment &&
              row.DocObjectCode === "oPurchaseInvoices",
          ) ?? null
        );
      },
      async listApInvoicePostingDates(onOrBefore) {
        const financialYear = indianFinancialYear(onOrBefore);
        const filter = encodeURIComponent(
          `DocDate ge '${financialYear.start}' and DocDate le '${onOrBefore}' and Cancelled eq 'tNO'`,
        );
        const rows = await pageAll<{ DocEntry?: number; DocDate?: string }>(
          `/PurchaseInvoices?$select=DocEntry,DocDate&$filter=${filter}&$orderby=DocDate%20desc,DocEntry%20desc`,
          500,
        );
        const dates = rows.map((row) => row.DocDate ?? "").filter(Boolean);
        return [...new Set(dates)];
      },
      async resolveGstApInvoiceSeries(postingDate, branchId, baseSeries) {
        let periodIndicator: string | null = null;
        if (Number.isInteger(baseSeries) && baseSeries! > 0) {
          try {
            const { body } = await request("/SeriesService_GetSeries", {
              method: "POST",
              body: JSON.stringify({ SeriesParams: { Series: baseSeries } }),
            });
            periodIndicator = seriesRows(body)[0]?.PeriodIndicator ?? null;
          } catch (error) {
            console.warn(
              "Could not read the base SAP numbering period",
              String(error),
            );
          }
        }

        let configured: SapNumberingSeries[] = [];
        let defaultSeries: number | null = null;
        try {
          const params = { Document: "18", DocumentSubType: "GA" };
          const available = await request("/SeriesService_GetDocumentSeries", {
            method: "POST",
            body: JSON.stringify({ DocumentTypeParams: params }),
          });
          configured = seriesRows(available.body);
          try {
            const preferred = await request("/SeriesService_GetDefaultSeries", {
              method: "POST",
              body: JSON.stringify({ DocumentTypeParams: params }),
            });
            defaultSeries = seriesRows(preferred.body)[0]?.Series ?? null;
          } catch {
            // The original SAP 10000521 response commonly means this user has no default.
          }
        } catch (error) {
          console.warn(
            "Could not list SAP GST A/P Invoice numbering series",
            String(error),
          );
        }

        const financialYear = indianFinancialYear(postingDate);
        const filter = encodeURIComponent(
          `DocDate ge '${financialYear.start}' and DocDate le '${financialYear.end}'`,
        );
        const invoices = await pageAll<SapNumberedApInvoice>(
          `/PurchaseInvoices?$select=DocEntry,DocDate,Series,DocumentSubType,BPL_IDAssignedToInvoice,Cancelled&$filter=${filter}&$orderby=DocDate%20desc,DocEntry%20desc`,
          1000,
        );
        const historicalSeries = selectExistingGstApInvoiceSeries({
          postingDate,
          branchId,
          invoices,
        });
        return (
          selectConfiguredGstApInvoiceSeries({
            branchId,
            periodIndicator,
            defaultSeries,
            historicalSeries,
            series: configured,
          }) ?? historicalSeries
        );
      },
      async listSuppliers() {
        return pageAll<SapSupplierRow>(
          "/BusinessPartners?$select=CardCode,CardName,BPAddresses&$filter=" +
            encodeURIComponent("CardType eq 'cSupplier' and Valid eq 'tYES'") +
            "&$orderby=CardCode%20asc",
          5000,
        );
      },
      async listBusinessPartnersPage(query) {
        return pageAll<Record<string, unknown>>(businessPartnerReadPath(query), query.limit + 1);
      },
      async searchSuppliers(query) {
        const term = query.trim().replaceAll("'", "''").slice(0, 60);
        if (term.length < 2) return [];
        const variants = [...new Set([term, term.toUpperCase(), term.toLowerCase()])];
        const filter = variants
          .flatMap((variant) => [
            `contains(CardName,'${variant}')`,
            `contains(CardCode,'${variant}')`,
          ])
          .join(" or ");
        return collectionOnce<SapSupplierRow>(
          `/BusinessPartners?$select=CardCode,CardName,BPAddresses&$filter=${encodeURIComponent(`CardType eq 'cSupplier' and (${filter})`)}&$orderby=CardCode%20asc`,
          25,
        );
      },
      async getSupplier(cardCode) {
        const rows = await collectionOnce<SapSupplierRow>(
          `/BusinessPartners?$select=CardCode,CardName,BPAddresses&$filter=${encodeURIComponent(`CardCode eq '${cardCode.replaceAll("'", "''")}' and CardType eq 'cSupplier'`)}`,
          1,
        );
        return rows[0] ?? null;
      },
      async listOpenReceiptDocumentsForVendor(cardCode) {
        return pageAll<SapMatchDocument>(
          "/PurchaseDeliveryNotes?$filter=" +
            encodeURIComponent(
              `CardCode eq '${cardCode.replaceAll("'", "''")}' and DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'`,
            ) +
            "&$orderby=DocEntry%20asc",
          1000,
        );
      },
      async findOpenReceiptDocumentsForInvoice(input) {
        const safeField = (value: string | undefined) =>
          value && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : null;
        const literal = (value: string) => value.replaceAll("'", "''");
        const identifiers: Array<{ label: string; filter: string }> = [];
        if (input.invoiceNumber.trim()) {
          const value = literal(input.invoiceNumber.trim());
          identifiers.push({ label: "NumAtCard", filter: `NumAtCard eq '${value}'` });
          const field = safeField(input.invoiceRefField);
          if (field) identifiers.push({ label: field, filter: `${field} eq '${value}'` });
        }
        const add = (fieldName: string | undefined, value: string | null) => {
          const field = safeField(fieldName);
          const wanted = value?.trim();
          if (field && wanted) identifiers.push({ label: field, filter: `${field} eq '${literal(wanted)}'` });
        };
        add(input.eWayBillField, input.eWayBill);
        add(input.lorryReceiptField, input.lorryReceipt);
        const vehicleField = safeField(input.vehicleField);
        if (vehicleField) {
          for (const vehicle of input.vehicles.filter(Boolean).slice(0, 4)) {
            identifiers.push({ label: vehicleField, filter: `${vehicleField} eq '${literal(vehicle)}'` });
          }
        }
        if (!identifiers.length) return [];
        // Query identifiers independently in strength order. Besides returning
        // as soon as an exact key succeeds, this makes optional SAP UDFs safe:
        // one missing field cannot break NumAtCard or the other configured keys.
        for (const identifier of identifiers) {
          try {
            const rows = await collectionOnce<SapMatchDocument>(
              "/PurchaseDeliveryNotes?$filter=" +
                encodeURIComponent(
                  `CardCode eq '${literal(input.cardCode)}' and DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO' and ${identifier.filter}`,
                ) +
                "&$orderby=DocEntry%20desc",
              100,
            );
            if (rows.length) return rows;
          } catch (error) {
            console.warn(
              `Could not query SAP receipts by ${identifier.label}; trying the next exact identifier.`,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        return [];
      },
      async listOpenPurchaseOrdersForVendor(cardCode) {
        return pageAll<SapMatchDocument>(
          "/PurchaseOrders?$filter=" +
            encodeURIComponent(
              `CardCode eq '${cardCode.replaceAll("'", "''")}' and DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'`,
            ) +
            "&$orderby=DocEntry%20asc",
          1000,
        );
      },
      async listPurchaseOrdersByEntries(entries) {
        const unique = [...new Set(entries.filter(Number.isInteger))];
        const documents: SapMatchDocument[] = [];
        for (let start = 0; start < unique.length; start += 15) {
          const filter = unique
            .slice(start, start + 15)
            .map((entry) => `DocEntry eq ${entry}`)
            .join(" or ");
          documents.push(
            ...(await collectionOnce<SapMatchDocument>(
              `/PurchaseOrders?$filter=${encodeURIComponent(filter)}`,
              15,
            )),
          );
        }
        return documents;
      },
      async listItemsByCodes(codes) {
        const unique = [...new Set(codes.filter(Boolean))];
        const rows: SapItemRow[] = [];
        for (let start = 0; start < unique.length; start += 15) {
          const filter = unique
            .slice(start, start + 15)
            .map((code) => `ItemCode eq '${code.replaceAll("'", "''")}'`)
            .join(" or ");
          rows.push(
            ...(await collectionOnce<SapItemRow>(
              `/Items?$select=ItemCode,ItemName,InventoryItem&$filter=${encodeURIComponent(filter)}`,
              15,
            )),
          );
        }
        return rows;
      },
      async searchItems(query) {
        const term = query.trim().replaceAll("'", "''").slice(0, 60);
        if (term.length < 2) return [];
        const variants = [...new Set([term, term.toUpperCase(), term.toLowerCase()])];
        const filter = variants
          .flatMap((variant) => [
            `contains(ItemName,'${variant}')`,
            `contains(ItemCode,'${variant}')`,
          ])
          .join(" or ");
        return collectionOnce<SapItemRow>(
          `/Items?$select=ItemCode,ItemName,InventoryItem&$filter=${encodeURIComponent(`Valid eq 'tYES' and (${filter})`)}&$orderby=ItemCode%20asc`,
          25,
        );
      },
      async findDraftByVendorReference(cardCode, vendorReference) {
        const filter = encodeURIComponent(
          `CardCode eq '${cardCode.replaceAll("'", "''")}' and NumAtCard eq '${vendorReference.replaceAll("'", "''")}' and DocObjectCode eq 'oPurchaseInvoices'`,
        );
        const { body } = await request(
          `/Drafts?$select=DocEntry,DocNum,CardCode,NumAtCard,Comments,DocObjectCode&$filter=${filter}&$top=5`,
        );
        const rows = Array.isArray(body.value)
          ? (body.value as SapDraftResponse[])
          : [];
        return rows[0] ?? null;
      },
      async createDraft(payload) {
        const { body } = await request("/Drafts", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        return body as SapDraftResponse;
      },
      async getDraft(docEntry) {
        const { body } = await request(`/Drafts(${docEntry})`);
        return body as SapDraftResponse;
      },
      async updateDraft(docEntry, payload) {
        await request(`/Drafts(${docEntry})`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      },
      async finalizeDraft(docEntry) {
        const { body } = await request("/DraftsService_SaveDraftToDocument", {
          method: "POST",
          body: JSON.stringify({ Document: { DocEntry: docEntry } }),
        });
        return body;
      },
      async getUserField(tableName, description) {
        const filter = encodeURIComponent(
          `TableName eq '${tableName.replaceAll("'", "''")}' and Description eq '${description.replaceAll("'", "''")}'`,
        );
        const { body } = await request(
          `/UserFieldsMD?$filter=${filter}&$top=2`,
        );
        const fields = Array.isArray(body.value)
          ? (body.value as Record<string, unknown>[])
          : [];
        if (fields.length > 1) {
          throw new Error(
            `SAP Test exposes more than one ${description} field on ${tableName}; final posting is blocked until the SAP metadata is unambiguous.`,
          );
        }
        return fields[0] ?? null;
      },
      async getUserFields(tableName, description) {
        const filter = encodeURIComponent(
          `TableName eq '${tableName.replaceAll("'", "''")}' and Description eq '${description.replaceAll("'", "''")}'`,
        );
        const { body } = await request(
          `/UserFieldsMD?$filter=${filter}&$top=100`,
        );
        return Array.isArray(body.value)
          ? (body.value as Record<string, unknown>[])
          : [];
      },
      async listInspectorDocuments(
        dataset,
        max,
        additionalHeaderFields = [],
      ) {
        const entity =
          dataset === "po"
            ? "PurchaseOrders"
            : dataset === "grpo"
              ? "PurchaseDeliveryNotes"
              : "PurchaseInvoices";
        const safeAdditionalFields = additionalHeaderFields.filter((field) =>
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(field),
        );
        const selectedFields = [
          "DocEntry",
          "DocNum",
          "DocDate",
          "TaxDate",
          "CardCode",
          "CardName",
          "NumAtCard",
          "DocTotal",
          "DocCurrency",
          "DocumentStatus",
          "Cancelled",
          "Series",
          "BPL_IDAssignedToInvoice",
          "Comments",
          "DocumentLines",
          ...safeAdditionalFields,
        ];
        return pageAll<Record<string, unknown>>(
          `/${entity}?$select=${[...new Set(selectedFields)].join(",")}&$orderby=DocEntry%20desc`,
          Math.min(500, Math.max(1, Math.floor(max))),
        );
      },
    });
  } finally {
    await request("/Logout", { method: "POST" }).catch(() => undefined);
  }
}

export async function fetchTestOpenGrpoRows(options?: {
  basePoDocNum?: string | number | null;
}): Promise<Record<string, unknown>[]> {
  return withTestServiceLayer(async (client) => {
    const requestedPo = sapDocumentNumber(options?.basePoDocNum);
    const purchaseOrders =
      requestedPo === null
        ? []
        : await client.listPurchaseOrdersByDocNum(requestedPo);
    const relatedDocuments =
      purchaseOrders.length > 0
        ? await client.listOpenGrposForPurchaseOrders(purchaseOrders)
        : [];
    const directlyReferencedDocuments =
      requestedPo === null ? [] : await client.listGrposByDocNum(requestedPo);
    const documents = Array.from(
      new Map(
        [
          ...relatedDocuments,
          ...directlyReferencedDocuments.filter(
            (document) =>
              document.DocumentStatus === "bost_Open" &&
              document.Cancelled === "tNO",
          ),
          ...(requestedPo === null ? await client.listOpenGrpos() : []),
        ].flatMap((document) =>
          typeof document.DocEntry === "number"
            ? [[document.DocEntry, document] as const]
            : [],
        ),
      ).values(),
    );
    const poDocNumByEntry = new Map(
      purchaseOrders.flatMap((document) =>
        typeof document.DocEntry === "number" &&
        typeof document.DocNum === "number"
          ? [[document.DocEntry, document.DocNum] as const]
          : [],
      ),
    );
    return documents.flatMap((document) =>
      (document.DocumentLines ?? [])
        .filter(
          (line) =>
            line.LineStatus === "bost_Open" &&
            (line.RemainingOpenQuantity ?? 0) > 0,
        )
        .map((line) => ({
          DocEntry: document.DocEntry,
          DocNum: document.DocNum,
          "BP Code": document.CardCode,
          "BP Name": document.CardName,
          "Base PO DocEntry": line.BaseEntry,
          "Base PO DocNum":
            typeof line.BaseEntry === "number"
              ? poDocNumByEntry.get(line.BaseEntry)
              : undefined,
          "PO Line Num": line.BaseLine ?? line.LineNum,
          ItemCode: line.ItemCode,
          Dscription: line.ItemDescription,
          Quantity: line.Quantity,
          OpenQty: line.RemainingOpenQuantity,
          Price: line.Price,
        })),
    );
  });
}
