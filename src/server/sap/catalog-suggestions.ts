import type { MatchInvoice, MatchContext } from "@/lib/sap-match/types";
import type { SapItemRow } from "./service-layer";

/** Search the printed description verbatim; no token scoring or inferred item links. */
export async function loadCatalogSuggestions(
  invoice: MatchInvoice,
  search: (query: string) => Promise<SapItemRow[]>,
): Promise<
  Pick<MatchContext, "itemMasterSuggestions" | "itemMasterSearchUnavailable">
> {
  const suggestions: NonNullable<MatchContext["itemMasterSuggestions"]> = {};
  const cache = new Map<string, Promise<SapItemRow[]>>();
  let unavailable = false;
  // Sequential, deduplicated calls avoid flooding SAP for multi-line invoices.
  for (const line of invoice.lines) {
    const description = line.description?.trim();
    if (!description || description.length < 2) continue;
    try {
      if (!cache.has(description)) cache.set(description, search(description));
      const rows = await cache.get(description)!;
      suggestions[String(line.index)] = [
        ...new Map(
          rows
            .filter(
              (row) =>
                row.ItemName?.trim().toLocaleLowerCase() ===
                description.toLocaleLowerCase(),
            )
            .map((row) => [
              row.ItemCode,
              {
                itemCode: row.ItemCode,
                name: row.ItemName || row.ItemCode,
                why: "Same name in SAP Item Master. Not proof of a supplier PO match; confirm before linking.",
              },
            ]),
        ).values(),
      ];
    } catch {
      // Catalog lookup is supplementary; preserve PO/GRPO matching on outage.
      unavailable = true;
    }
  }
  return {
    itemMasterSuggestions: suggestions,
    itemMasterSearchUnavailable: unavailable,
  };
}
