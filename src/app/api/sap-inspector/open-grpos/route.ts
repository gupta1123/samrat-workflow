import { ApiError, withUser } from "@/server/api/helpers";
import { withTestServiceLayer } from "@/server/sap/service-layer";
import { sapFieldConfig } from "@/server/sap/match-data";
import { normalizeSapInspectorRecords } from "@/lib/sap-inspector";
import {
  grpoPageRows,
  parseGrpoInspectorQuery,
} from "@/lib/sap-grpo-inspector";
import { grpoPdfAvailability } from "@/server/sap/grpo-pdf-availability";
import { grpoUploadStates } from "@/server/sap/grpo-import";
import type { SapInspectorRecord } from "@/lib/sap-inspector";
import type { GrpoUploadState } from "@/lib/grpo-import";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) {
  return withUser(request, async (db, user) => {
    const params = new URL(request.url).searchParams;
    if (!params.has("limit")) params.set("limit", "10");
    let query;
    try {
      query = parseGrpoInspectorQuery(params);
    } catch {
      throw new ApiError("Invalid GRPO search.");
    }
    const tab = params.get("uploaded") ?? "no";
    if (tab !== "yes" && tab !== "no")
      throw new ApiError("Invalid upload tab.");
    const config = sapFieldConfig();
    const company = process.env.SAP_SL_TEST_COMPANY_DB;
    if (!company)
      throw new ApiError("SAP Test company is not configured.", 503);
    return withTestServiceLayer(async (client) => {
      const records: SapInspectorRecord[] = [];
      const uploads: Record<string, GrpoUploadState> = {};
      let cursor = query.before;
      let nextCursor: number | null = null;
      // Filter before returning a page, retaining a cursor even for sparse tabs.
      for (let scan = 0; scan < 5 && records.length < query.limit; scan++) {
        const page = grpoPageRows(
          await client.listInspectorGrposPage(
            { ...query, status: "open", before: cursor },
            {
              invoice: config.invoiceRefField ?? "",
              eWayBill: config.eWayBillField ?? "",
              lorryReceipt: config.lorryReceiptField ?? "",
              vehicle: config.vehicleField ?? "",
            },
          ),
          query.limit,
        );
        const basic = normalizeSapInspectorRecords("grpo", page.rows);
        const states = await grpoUploadStates(db, user, company, basic);
        let consumed = 0;
        for (const record of basic) {
          consumed++;
          const saved = states[String(record.docEntry)];
          const upload = saved?.deleted ? undefined : saved;
          if (Boolean(upload) === (tab === "yes")) {
            records.push(record);
            if (upload) uploads[String(record.docEntry)] = upload;
          }
          if (records.length === query.limit) {
            nextCursor =
              consumed < basic.length || page.nextCursor !== null
                ? Number(record.docEntry)
                : null;
            break;
          }
        }
        if (records.length === query.limit) break;
        nextCursor = page.nextCursor;
        if (nextCursor === null) break;
        cursor = nextCursor;
      }
      const poEntries = [
        ...new Set(
          records
            .flatMap((r) => r.lines)
            .filter((l) => l.baseType === 22 && l.baseEntry !== null)
            .map((l) => l.baseEntry!),
        ),
      ];
      const purchaseOrders = poEntries.length
        ? await client.listPurchaseOrdersByEntries(poEntries)
        : [];
      const pdfs = await grpoPdfAvailability(
        records.filter((r) => !uploads[String(r.docEntry)]),
        (entry) => client.getAttachmentMetadata(entry),
      );
      return {
        pdfs,
        records: normalizeSapInspectorRecords(
          "grpo",
          records.map((r) => r.raw),
          {
            purchaseOrders,
            poReferenceFields: config.poRefFields,
            vehicleField: config.vehicleField,
            invoiceField: config.invoiceRefField,
            eWayBillField: config.eWayBillField,
            lorryReceiptField: config.lorryReceiptField,
          },
        ),
        uploads,
        nextCursor,
        fetchedAt: new Date().toISOString(),
        company,
      };
    });
  });
}
