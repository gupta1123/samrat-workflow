import { sapCaseOrigin } from "@/server/sap/config";
import { requireActiveSapCase } from "@/server/sap/case-environment";
import { ownedCase, withUser } from "@/server/api/helpers";
import { withSapServiceLayer } from "@/server/sap/service-layer";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    const row = await ownedCase(db, user, id);
    const sapEnv = requireActiveSapCase(
      sapCaseOrigin(row.created_at, row.processing_meta),
    );
    const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
    if (query.length < 2) return { vendors: [] };
    const rows = await withSapServiceLayer(
      (client) => client.searchSuppliers(query),
      sapEnv,
    );
    return {
      vendors: rows.map((row) => ({
        cardCode: row.CardCode,
        cardName: row.CardName,
      })),
    };
  });
}
