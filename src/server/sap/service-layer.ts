import "server-only";

import { sapFetch } from "./http";
import type { SapGrpo } from "./ap-draft";

type SapDraftResponse = {
  DocEntry?: number;
  DocNum?: number;
  CardCode?: string;
  Comments?: string;
  DocObjectCode?: string;
};

export type SapReadDocument = Omit<SapGrpo, "DocumentLines"> & {
  NumAtCard?: string | null;
  DocTotal?: number;
  DocumentLines?: Array<NonNullable<SapGrpo["DocumentLines"]>[number] & {
    Price?: number;
    BaseType?: number;
    BaseEntry?: number | null;
    BaseLine?: number | null;
  }>;
};

function testConfig() {
  const baseUrl = (process.env.SAP_SL_TEST_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const company = (process.env.SAP_SL_TEST_COMPANY_DB ?? "").trim();
  const username = (process.env.SAP_SL_TEST_USERNAME ?? "").trim();
  const password = (process.env.SAP_SL_TEST_PASSWORD ?? "").trim();
  if (!baseUrl || !company || !username || !password) {
    throw new Error("SAP Test Service Layer is not configured on the server.");
  }
  if (!baseUrl.startsWith("https://") || !baseUrl.endsWith("/b1s/v1")) {
    throw new Error("SAP Test Service Layer URL must be an HTTPS /b1s/v1 endpoint.");
  }
  return { baseUrl, company, username, password };
}

export async function withTestServiceLayer<T>(
  action: (client: {
    listOpenGrpos: () => Promise<SapGrpo[]>;
    getGrpo: (docEntry: number) => Promise<SapGrpo>;
    listGrposByDocNum: (docNum: number) => Promise<SapReadDocument[]>;
    getPurchaseOrder: (docEntry: number) => Promise<SapReadDocument>;
    listInvoicesByAmount: (cardCode: string, amount: number) => Promise<SapReadDocument[]>;
    findInvoiceByReference: (cardCode: string, vendorReference: string) => Promise<SapReadDocument | null>;
    findDraft: (comment: string) => Promise<SapDraftResponse | null>;
    createDraft: (payload: Record<string, unknown>) => Promise<SapDraftResponse>;
    getDraft: (docEntry: number) => Promise<SapDraftResponse>;
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
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        const sapError = body.error as { message?: { value?: string } } | undefined;
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
  const routeId = login.response.headers.get("set-cookie")?.match(/ROUTEID=[^;\s,]+/)?.[0];
  cookie = [`B1SESSION=${sessionId}`, routeId].filter(Boolean).join("; ");

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
          const page = Array.isArray(body.value) ? (body.value as SapGrpo[]) : [];
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
        return Array.isArray(body.value) ? body.value as SapReadDocument[] : [];
      },
      async getPurchaseOrder(docEntry) {
        const { body } = await request(`/PurchaseOrders(${docEntry})`);
        return body as SapReadDocument;
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
        return Array.isArray(body.value) ? body.value as SapReadDocument[] : [];
      },
      async findInvoiceByReference(cardCode, vendorReference) {
        const filter = encodeURIComponent(
          `CardCode eq '${cardCode.replace(/'/g, "''")}' and NumAtCard eq '${vendorReference.replace(/'/g, "''")}'`,
        );
        const { body } = await request(
          `/PurchaseInvoices?$select=DocEntry,DocNum,CardCode,NumAtCard,Cancelled&$filter=${filter}&$top=10`,
        );
        const rows = Array.isArray(body.value) ? body.value as SapReadDocument[] : [];
        return rows.find((row) => row.Cancelled === "tNO") ?? null;
      },
      async findDraft(comment) {
        const filter = encodeURIComponent(`Comments eq '${comment.replace(/'/g, "''")}'`);
        const { body } = await request(`/Drafts?$filter=${filter}&$top=5`);
        const rows = Array.isArray(body.value) ? (body.value as SapDraftResponse[]) : [];
        return rows.find((row) => row.Comments === comment && row.DocObjectCode === "oPurchaseInvoices") ?? null;
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
    });
  } finally {
    await request("/Logout", { method: "POST" }).catch(() => undefined);
  }
}

export async function fetchTestOpenGrpoRows(): Promise<Record<string, unknown>[]> {
  return withTestServiceLayer(async (client) => {
    const documents = await client.listOpenGrpos();
    return documents.flatMap((document) =>
      (document.DocumentLines ?? [])
        .filter((line) => line.LineStatus === "bost_Open" && (line.RemainingOpenQuantity ?? 0) > 0)
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
