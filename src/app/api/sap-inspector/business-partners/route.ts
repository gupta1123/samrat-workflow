import { ApiError, withUser } from "@/server/api/helpers";
import { withTestServiceLayer } from "@/server/sap/service-layer";
import {
  businessPartnerPage,
  parseBusinessPartnerQuery,
  type BusinessPartnerQuery,
} from "@/lib/sap-business-partners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withUser(request, async () => {
    let query: BusinessPartnerQuery;
    try {
      query = parseBusinessPartnerQuery(new URL(request.url).searchParams);
    } catch (error) {
      throw new ApiError(
        error instanceof Error ? error.message : "Invalid search.",
        400,
      );
    }
    try {
      const rows = await withTestServiceLayer((client) =>
        client.listBusinessPartnersPage(query),
      );
      return {
        ...businessPartnerPage(rows, query.limit),
        pageSize: query.limit,
        environment: "test",
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      console.error(
        "SAP Business Partners read failed",
        error instanceof Error ? error.message : String(error),
      );
      throw new ApiError(
        "Could not read Business Partners from SAP Test. Retry or check the SAP connection.",
        502,
      );
    }
  });
}
