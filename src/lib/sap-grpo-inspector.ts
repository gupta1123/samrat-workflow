import type { SapInspectorRecord } from "./sap-inspector";

export type GrpoInspectorQuery = {
  search: string;
  supplier: string;
  status: "all" | "open" | "closed";
  before: number | null;
  limit: number;
};
export type GrpoReferenceFields = {
  invoice: string;
  eWayBill: string;
  lorryReceipt: string;
  vehicle: string;
};
export type GrpoInspectorPage = {
  records: SapInspectorRecord[];
  nextCursor: number | null;
  fetchedAt: string;
};

export function parseGrpoInspectorQuery(
  params: URLSearchParams,
): GrpoInspectorQuery {
  const status = params.get("status") ?? "open";
  if (!["all", "open", "closed"].includes(status))
    throw new Error("Choose a valid GRPO status.");
  const search = (params.get("q") ?? "").trim();
  const supplier = (params.get("supplier") ?? "").trim();
  if (search.length > 100 || supplier.length > 100)
    throw new Error("Search or supplier code is too long.");
  const before = params.has("before") ? Number(params.get("before")) : null;
  if (before !== null && (!Number.isSafeInteger(before) || before <= 0))
    throw new Error("Invalid GRPO page cursor.");
  const limit = Number(params.get("limit") ?? 25);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Page size must be between 1 and 100.");
  return {
    search,
    supplier,
    status: status as GrpoInspectorQuery["status"],
    before,
    limit,
  };
}

export function grpoInspectorReadPath(
  query: GrpoInspectorQuery,
  fields: GrpoReferenceFields,
) {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const safeFields = [
    ...new Set(
      Object.values(fields).filter((field) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(field),
      ),
    ),
  ];
  const filters: string[] = [];
  if (query.supplier) filters.push(`CardCode eq ${quote(query.supplier)}`);
  if (query.before !== null) filters.push(`DocEntry lt ${query.before}`);
  if (query.status === "open")
    filters.push("DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'");
  if (query.status === "closed")
    filters.push("DocumentStatus eq 'bost_Close' and Cancelled eq 'tNO'");
  if (query.search) {
    const variants = [
      ...new Set([
        query.search,
        query.search.toUpperCase(),
        query.search.toLowerCase(),
      ]),
    ];
    const terms = variants.flatMap((value) =>
      ["CardCode", "CardName", "NumAtCard", "Comments", ...safeFields].map(
        (field) => `contains(${field},${quote(value)})`,
      ),
    );
    if (
      /^\d+$/.test(query.search) &&
      Number.isSafeInteger(Number(query.search))
    )
      terms.push(
        `DocNum eq ${Number(query.search)}`,
        `DocEntry eq ${Number(query.search)}`,
      );
    filters.push(`(${terms.join(" or ")})`);
  }
  const params = new URLSearchParams({
    $select: [
      ...new Set([
        "DocEntry",
        "DocNum",
        "DocDate",
        "TaxDate",
        "CardCode",
        "CardName",
        "NumAtCard",
        "DocTotal",
        "DocCurrency",
        "DocumentStatus",
        "Cancelled",
        "BPL_IDAssignedToInvoice",
        "Comments",
        "DocumentLines",
        ...safeFields,
      ]),
    ].join(","),
    $orderby: "DocEntry desc",
  });
  if (filters.length) params.set("$filter", filters.join(" and "));
  return `/PurchaseDeliveryNotes?${params}`;
}

export function grpoPageRows(rows: Record<string, unknown>[], limit: number) {
  const selected = rows.slice(0, limit);
  const last = selected.at(-1)?.DocEntry;
  if (
    selected.some(
      (row) => !Number.isSafeInteger(row.DocEntry) || Number(row.DocEntry) <= 0,
    )
  )
    throw new Error("SAP returned a GRPO without a valid document entry.");
  return {
    rows: selected,
    nextCursor: rows.length > limit ? Number(last) : null,
  };
}
