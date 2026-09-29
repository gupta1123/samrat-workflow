import { ApiError, ownedCase, withUser } from "@/server/api/helpers";
import { readSapEnvironment } from "@/server/sap/config";
import { withTestServiceLayer } from "@/server/sap/service-layer";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    await ownedCase(db, user, id);
    if (readSapEnvironment() !== "test") {
      throw new ApiError("SAP matching is available only against the SAP Test company for now.", 409);
    }
    const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
    if (query.length < 2) return { vendors: [] };
    const rows = await withTestServiceLayer((client) => client.searchSuppliers(query));
    return { vendors: rows.map((row) => ({ cardCode: row.CardCode, cardName: row.CardName })) };
  });
}
