import "server-only";

import { sapFetch } from "./http";
import type { SapGrpo } from "./ap-draft";
import {
  indianFinancialYear,
  selectConfiguredGstApInvoiceSeries,
  selectExistingGstApInvoiceSeries,
  type SapNumberedApInvoice,
  type SapNumberingSeries,
} from "./numbering-series";

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
    getGrpo: (docEntry: number) => Promise<SapGrpo>;
    listGrposByDocNum: (docNum: number) => Promise<SapReadDocument[]>;
    getPurchaseOrder: (docEntry: number) => Promise<SapReadDocument>;
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
    findDraft: (comment: string) => Promise<SapDraftResponse | null>;
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
    finalizeDraft: (docEntry: number) => Promise<Record<string, unknown>>;
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

  try {
    return await action({
      async listOpenGrpos() {
        const rows: SapGrpo[] = [];
        for (let skip = 0; skip < 1000; skip += 100) {
          const query =
            "/PurchaseDeliveryNotes?$select=DocEntry,DocNum,CardCode,CardName,DocumentStatus,Cancelled,DocumentLines" +
            "&$filter=DocumentStatus%20eq%20%27bost_Open%27" +
            `&$top=100&$skip=${skip}`;
          const { body } = await request(query);
          const page = Array.isArray(body.value)
            ? (body.value as SapGrpo[])
            : [];
          rows.push(...page.filter((row) => row.Cancelled === "tNO"));
          if (page.length < 100) return rows;
        }
        throw new Error("SAP Test has too many open GRPOs to select safely.");
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
        const dates: string[] = [];
        for (let skip = 0; skip < 500; skip += 100) {
          const { body } = await request(
            `/PurchaseInvoices?$select=DocEntry,DocDate&$filter=${filter}&$orderby=DocDate%20desc,DocEntry%20desc&$top=100&$skip=${skip}`,
          );
          const page = Array.isArray(body.value)
            ? (body.value as Array<{ DocEntry?: number; DocDate?: string }>)
            : [];
          dates.push(...page.map((row) => row.DocDate ?? "").filter(Boolean));
          if (page.length < 100) break;
        }
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
        const invoices: SapNumberedApInvoice[] = [];
        for (let skip = 0; skip < 1000; skip += 100) {
          const { body } = await request(
            `/PurchaseInvoices?$select=DocEntry,DocDate,Series,DocumentSubType,BPL_IDAssignedToInvoice,Cancelled&$filter=${filter}&$orderby=DocDate%20desc,DocEntry%20desc&$top=100&$skip=${skip}`,
          );
          const page = Array.isArray(body.value)
            ? (body.value as SapNumberedApInvoice[])
            : [];
          invoices.push(...page);
          if (page.length < 100) break;
        }
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
      async finalizeDraft(docEntry) {
        const { body } = await request("/DraftsService_SaveDraftToDocument", {
          method: "POST",
          body: JSON.stringify({ Document: { DocEntry: docEntry } }),
        });
        return body;
      },
    });
  } finally {
    await request("/Logout", { method: "POST" }).catch(() => undefined);
  }
}

export async function fetchTestOpenGrpoRows(): Promise<
  Record<string, unknown>[]
> {
  return withTestServiceLayer(async (client) => {
    const documents = await client.listOpenGrpos();
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
          "PO Line Num": line.LineNum,
          ItemCode: line.ItemCode,
          Dscription: line.ItemDescription,
          Quantity: line.Quantity,
          OpenQty: line.RemainingOpenQuantity,
        })),
    );
  });
}
