import { ApiError, withUser } from "@/server/api/helpers";
import { withTestServiceLayer } from "@/server/sap/service-layer";
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
      const rows = await withTestServiceLayer((client) =>
        client.listInspectorItemsPage(query),
      );
      return {
        ...itemsPage(rows, query.limit),
        environment: "test",
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      console.error(
        "SAP Item Master read failed",
        error instanceof Error ? error.message : String(error),
      );
      throw new ApiError(
        "Could not read items from SAP Test. Retry or check the SAP connection.",
        502,
      );
    }
  });
}
