import { fetchCasePage, type SavedCaseRecord } from "./case-persistence";

export type ApprovalFilter =
  "all" | "pending" | "in_review" | "completed" | "failed";
export type ReconciliationFilter = "all" | "issues" | "clean";
export type CaseListQuery = {
  query: string;
  approval: ApprovalFilter;
  reconciliation: ReconciliationFilter;
  page: number;
  pageSize: number;
};
export type CachedCaseList = {
  cases: SavedCaseRecord[];
  totalCount: number;
  totalPages: number;
};

// Preserve the existing client-side reconciliation-filter scan limit.
const RECONCILIATION_SCAN_LIMIT = 500;

export function getCaseListCacheKey(params: CaseListQuery) {
  return [
    "active",
    params.query.trim().toLowerCase(),
    params.approval,
    params.reconciliation,
    `page:${params.page}`,
    `limit:${params.pageSize}`,
  ].join(":");
}

function matchesReconciliation(
  item: SavedCaseRecord,
  filter: ReconciliationFilter,
) {
  if (filter === "issues") return item.mismatchCount > 0;
  if (filter === "clean")
    return (
      ["completed", "accepted", "rejected"].includes(item.status) &&
      item.mismatchCount === 0
    );
  return true;
}

export function createCaseListLoader(
  readPage: typeof fetchCasePage = fetchCasePage,
) {
  const cache = new Map<string, CachedCaseList>();
  const pending = new Map<string, Promise<CachedCaseList>>();
  let revision = 0;

  async function load(params: CaseListQuery): Promise<CachedCaseList> {
    const filtered = params.reconciliation !== "all";
    const payload = await readPage({
      scope: "active",
      limit: filtered ? RECONCILIATION_SCAN_LIMIT : params.pageSize,
      page: filtered ? 1 : params.page,
      query: params.query,
      statusFilter: params.approval,
    });
    if (!filtered)
      return {
        cases: payload.cases,
        totalCount: payload.totalCount ?? payload.cases.length,
        totalPages: Math.max(1, payload.totalPages ?? 1),
      };
    const matching = payload.cases.filter((item) =>
      matchesReconciliation(item, params.reconciliation),
    );
    const start = (params.page - 1) * params.pageSize;
    return {
      cases: matching.slice(start, start + params.pageSize),
      totalCount: matching.length,
      totalPages: Math.max(1, Math.ceil(matching.length / params.pageSize)),
    };
  }

  function read(params: CaseListQuery) {
    const key = getCaseListCacheKey(params);
    const existing = pending.get(key);
    if (existing) return existing;
    const startedAt = revision;
    const request = load(params)
      .then((result) => {
        if (startedAt === revision) cache.set(key, result);
        return result;
      })
      .finally(() => {
        // An older request must not remove a newer request for the same page.
        if (pending.get(key) === request) pending.delete(key);
      });
    pending.set(key, request);
    return request;
  }

  function invalidate() {
    revision++;
    cache.clear();
    pending.clear();
  }

  return {
    get revision() {
      return revision;
    },
    peek: (params: CaseListQuery) => cache.get(getCaseListCacheKey(params)),
    read,
    async refillAfterRemoval(params: CaseListQuery) {
      // Deletion shifts every offset/page and every filtered count.
      invalidate();
      let page = params.page;
      let result = await read(params);
      while (page > result.totalPages) {
        page = Math.max(1, result.totalPages);
        result = await read({ ...params, page });
      }
      return { ...result, page };
    },
  };
}
