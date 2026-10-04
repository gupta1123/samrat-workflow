export type BusinessPartnerType = "all" | "cSupplier" | "cCustomer" | "cLid";
export type BusinessPartnerQuery = {
  search: string;
  type: BusinessPartnerType;
  after: string | null;
  limit: number;
};
export type BusinessPartnerRecord = {
  code: string;
  name: string | null;
  type: string;
  valid: boolean | null;
  frozen: boolean | null;
  currency: string | null;
  gstins: string[];
  addresses: Array<{
    name: string | null;
    type: string | null;
    gstin: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
  }>;
};
export type BusinessPartnerPage = {
  records: BusinessPartnerRecord[];
  nextCursor: string | null;
  pageSize: number;
  environment: "test";
  fetchedAt: string;
};

export const BUSINESS_PARTNER_TYPES: Array<[BusinessPartnerType, string]> = [
  ["all", "All types"],
  ["cSupplier", "Suppliers"],
  ["cCustomer", "Customers"],
  ["cLid", "Leads"],
];

export function businessPartnerTypeLabel(type: string) {
  return (
    (
      { cSupplier: "Supplier", cCustomer: "Customer", cLid: "Lead" } as Record<
        string,
        string
      >
    )[type] ?? type
  );
}

export function parseBusinessPartnerQuery(
  params: URLSearchParams,
): BusinessPartnerQuery {
  const type = params.get("type") ?? "all";
  if (!BUSINESS_PARTNER_TYPES.some(([value]) => value === type))
    throw new Error("Choose a valid business partner type.");
  const limit = Number(params.get("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Page size must be between 1 and 100.");
  const search = (params.get("q") ?? "").trim();
  const after = params.get("after") || null;
  if (search.length > 100 || (after?.length ?? 0) > 100)
    throw new Error("Search or page cursor is too long.");
  return { search, type: type as BusinessPartnerType, after, limit };
}

export function businessPartnerReadPath(query: BusinessPartnerQuery) {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const filters: string[] = [];
  if (query.type !== "all") filters.push(`CardType eq ${quote(query.type)}`);
  if (query.after) filters.push(`CardCode gt ${quote(query.after)}`);
  if (query.search) {
    const variants = [
      ...new Set([
        query.search,
        query.search.toUpperCase(),
        query.search.toLowerCase(),
      ]),
    ];
    filters.push(
      `(${variants.flatMap((value) => [`contains(CardCode,${quote(value)})`, `contains(CardName,${quote(value)})`]).join(" or ")})`,
    );
  }
  const params = new URLSearchParams({
    $select: "CardCode,CardName,CardType,Valid,Frozen,Currency,BPAddresses",
    $orderby: "CardCode asc",
  });
  if (filters.length) params.set("$filter", filters.join(" and "));
  return `/BusinessPartners?${params}`;
}

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const flag = (value: unknown) =>
  value === "tYES" ? true : value === "tNO" ? false : null;

export function normalizeBusinessPartner(
  source: Record<string, unknown>,
): BusinessPartnerRecord {
  const code = text(source.CardCode);
  if (!code)
    throw new Error("SAP returned a business partner without a BP Code.");
  const addresses = (
    Array.isArray(source.BPAddresses) ? source.BPAddresses : []
  ).map((value) => {
    const address =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    return {
      name: text(address.AddressName),
      type: text(address.AddressType),
      gstin: text(address.GSTIN),
      city: text(address.City),
      state: text(address.State),
      country: text(address.Country),
    };
  });
  return {
    code,
    name: text(source.CardName),
    type: text(source.CardType) ?? "Unknown",
    valid: flag(source.Valid),
    frozen: flag(source.Frozen),
    currency: text(source.Currency),
    addresses,
    gstins: [
      ...new Set(
        addresses
          .map((address) => address.gstin)
          .filter((value): value is string => Boolean(value)),
      ),
    ],
  };
}

export function businessPartnerPage(
  rows: Record<string, unknown>[],
  limit: number,
) {
  const records = rows.slice(0, limit).map(normalizeBusinessPartner);
  return {
    records,
    nextCursor: rows.length > limit ? records.at(-1)!.code : null,
  };
}
