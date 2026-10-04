import { ApiError, withUser } from "@/server/api/helpers";
import { withTestServiceLayer } from "@/server/sap/service-layer";
import { sapFieldConfig } from "@/server/sap/match-data";
import { normalizeSapInspectorRecords } from "@/lib/sap-inspector";
import {
  grpoPageRows,
  parseGrpoInspectorQuery,
  type GrpoInspectorQuery,
} from "@/lib/sap-grpo-inspector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withUser(request, async () => {
    let query: GrpoInspectorQuery;
    try {
      query = parseGrpoInspectorQuery(new URL(request.url).searchParams);
    } catch (error) {
      throw new ApiError(
        error instanceof Error ? error.message : "Invalid search.",
        400,
      );
    }
    const config = sapFieldConfig();
    try {
      return await withTestServiceLayer(async (client) => {
        const page = grpoPageRows(
          await client.listInspectorGrposPage(query, {
            invoice: config.invoiceRefField ?? "",
            eWayBill: config.eWayBillField ?? "",
            lorryReceipt: config.lorryReceiptField ?? "",
            vehicle: config.vehicleField ?? "",
          }),
          query.limit,
        );
        const entries = [
          ...new Set(
            page.rows
              .flatMap((row) =>
                Array.isArray(row.DocumentLines) ? row.DocumentLines : [],
              )
              .filter(
                (line) =>
                  line.BaseType === 22 && Number.isInteger(line.BaseEntry),
              )
              .map((line) => line.BaseEntry as number),
          ),
        ];
        const purchaseOrders = entries.length
          ? await client.listPurchaseOrdersByEntries(entries)
          : [];
        return {
          records: normalizeSapInspectorRecords("grpo", page.rows, {
            purchaseOrders,
            poReferenceFields: config.poRefFields,
            vehicleField: config.vehicleField,
            invoiceField: config.invoiceRefField,
            eWayBillField: config.eWayBillField,
            lorryReceiptField: config.lorryReceiptField,
          }),
          nextCursor: page.nextCursor,
          fetchedAt: new Date().toISOString(),
        };
      });
    } catch (error) {
      console.error(
        "SAP GRPO inspector read failed",
        error instanceof Error ? error.message : String(error),
      );
      throw new ApiError(
        "Could not read GRPOs and their linked Purchase Orders from SAP Test. Retry or check the SAP connection.",
        502,
      );
    }
  });
}
