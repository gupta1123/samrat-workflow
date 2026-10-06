export type ItemsQuery = {
  search: string;
  after: string | null;
  limit: number;
};
export type ItemRecord = {
  code: string;
  name: string | null;
  inventory: boolean | null;
  sales: boolean | null;
  purchase: boolean | null;
  valid: boolean | null;
  frozen: boolean | null;
};
export type ItemsPage = {
  records: ItemRecord[];
  nextCursor: string | null;
  fetchedAt: string;
};

export function parseItemsQuery(params: URLSearchParams): ItemsQuery {
  const search = (params.get("q") ?? "").trim();
  const after = params.get("after") || null;
  const limit = Number(params.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Page size must be between 1 and 100.");
  if (search.length > 100 || (after?.length ?? 0) > 100)
    throw new Error("Search or cursor is too long.");
  return { search, after, limit };
}

export function itemsReadPath(query: ItemsQuery) {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const filters: string[] = [];
  if (query.after) filters.push(`ItemCode gt ${quote(query.after)}`);
  if (query.search) {
    const variants = [
      ...new Set([
        query.search,
        query.search.toUpperCase(),
        query.search.toLowerCase(),
      ]),
    ];
    filters.push(
      `(${variants.flatMap((value) => [`contains(ItemCode,${quote(value)})`, `contains(ItemName,${quote(value)})`]).join(" or ")})`,
    );
  }
  const params = new URLSearchParams({
    $select:
      "ItemCode,ItemName,InventoryItem,SalesItem,PurchaseItem,Valid,Frozen",
    $orderby: "ItemCode asc",
  });
  if (filters.length) params.set("$filter", filters.join(" and "));
  return `/Items?${params}`;
}

export function itemsPage(rows: Record<string, unknown>[], limit: number) {
  const flag = (value: unknown) =>
    value === "tYES" ? true : value === "tNO" ? false : null;
  const records = rows.slice(0, limit).map((row): ItemRecord => {
    if (typeof row.ItemCode !== "string" || !row.ItemCode)
      throw new Error("SAP returned an item without a code.");
    return {
      code: row.ItemCode,
      name: typeof row.ItemName === "string" ? row.ItemName : null,
      inventory: flag(row.InventoryItem),
      sales: flag(row.SalesItem),
      purchase: flag(row.PurchaseItem),
      valid: flag(row.Valid),
      frozen: flag(row.Frozen),
    };
  });
  return {
    records,
    nextCursor: rows.length > limit ? records.at(-1)!.code : null,
  };
}
