import { readSapEnvironment } from "@/server/sap/config";
import { ApiError, withUser } from "@/server/api/helpers";
import { withSapServiceLayer } from "@/server/sap/service-layer";
import {
  parseItemsQuery,
  itemsPage,
  type ItemsQuery,
} from "@/lib/sap-items-inspector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withUser(request, async () => {
    let query: ItemsQuery;
    try {
      query = parseItemsQuery(new URL(request.url).searchParams);
    } catch (error) {
      throw new ApiError(
        error instanceof Error ? error.message : "Invalid search.",
        400,
      );
    }
    try {
      const rows = await withSapServiceLayer((client) =>
        client.listInspectorItemsPage(query),
      );
      return {
        ...itemsPage(rows, query.limit),
        environment: readSapEnvironment(),
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      console.error(
        "SAP Item Master read failed",
        error instanceof Error ? error.message : String(error),
      );
      throw new ApiError(
        "Could not read items from SAP. Retry or check the SAP connection.",
        502,
      );
    }
  });
}
