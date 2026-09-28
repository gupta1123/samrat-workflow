"use client";

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Filter,
  FolderOpen,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { CaseConfirmDialog } from "@/components/cases/CaseConfirmDialog";
import { AppShell } from "@/components/dashboard/AppShell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  fetchCaseDetailPreferCache,
  fetchCasePage,
  recycleCase,
  type SavedCaseRecord,
} from "@/lib/case-persistence";

type LoadState = "loading" | "ready" | "error";
type ApprovalFilter = "all" | "pending" | "in_review" | "completed" | "failed";
type ReconciliationFilter = "all" | "issues" | "clean";
type CaseListQuery = {
  query: string;
  approval: ApprovalFilter;
  reconciliation: ReconciliationFilter;
  page: number;
  pageSize: number;
};
type CachedCaseList = {
  cases: SavedCaseRecord[];
  totalCount: number;
  totalPages: number;
};

const PAGE_SIZE_OPTIONS = [10, 25, 50];
// The list API has no reconciliation filter, so that filter reads up to this
// many cases for the approval state and paginates them in the browser.
const RECONCILIATION_SCAN_LIMIT = 500;

const APPROVAL_OPTIONS: { value: ApprovalFilter; label: string }[] = [
  { value: "all", label: "All Approval States" },
  { value: "in_review", label: "Pending approval" },
  { value: "completed", label: "Approved" },
  { value: "failed", label: "Rejected / failed" },
  { value: "pending", label: "Draft" },
];

const RECONCILIATION_OPTIONS: { value: ReconciliationFilter; label: string }[] =
  [
    { value: "all", label: "All Reconciliation" },
    { value: "issues", label: "Has issues" },
    { value: "clean", label: "No issues" },
  ];

const caseListCache = new Map<string, CachedCaseList>();
const pendingCaseListReads = new Map<string, Promise<CachedCaseList>>();

function warmCaseDetail(caseId: string) {
  void fetchCaseDetailPreferCache(caseId).catch(() => {
    // Navigation still performs its normal load if a speculative read fails.
  });
}

function getCaseListCacheKey(params: CaseListQuery) {
  return [
    "active",
    params.query.trim().toLowerCase(),
    params.approval,
    params.reconciliation,
    `page:${params.page}`,
    `limit:${params.pageSize}`,
  ].join(":");
}

function hasAnalysisResult(item: SavedCaseRecord) {
  return (
    item.status === "completed" ||
    item.status === "accepted" ||
    item.status === "rejected"
  );
}

function matchesReconciliation(
  item: SavedCaseRecord,
  filter: ReconciliationFilter,
) {
  if (filter === "issues") return item.mismatchCount > 0;
  if (filter === "clean")
    return hasAnalysisResult(item) && item.mismatchCount === 0;
  return true;
}

async function loadCaseList(params: CaseListQuery): Promise<CachedCaseList> {
  const statusFilter = params.approval;
  if (params.reconciliation === "all") {
    const payload = await fetchCasePage({
      scope: "active",
      limit: params.pageSize,
      page: params.page,
      query: params.query,
      statusFilter,
    });
    return {
      cases: payload.cases,
      totalCount: payload.totalCount ?? payload.cases.length,
      totalPages: payload.totalPages ?? 1,
    };
  }

  const payload = await fetchCasePage({
    scope: "active",
    limit: RECONCILIATION_SCAN_LIMIT,
    page: 1,
    query: params.query,
    statusFilter,
  });
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

function fetchCaseListOnce(cacheKey: string, params: CaseListQuery) {
  const pending = pendingCaseListReads.get(cacheKey);
  if (pending) return pending;

  const request = loadCaseList(params)
    .then((result) => {
      caseListCache.set(cacheKey, result);
      return result;
    })
    .finally(() => {
      pendingCaseListReads.delete(cacheKey);
    });

  pendingCaseListReads.set(cacheKey, request);
  return request;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getApprovalPill(item: SavedCaseRecord) {
  switch (item.status) {
    case "accepted":
      return {
        label: "Approved",
        className: "border-emerald-200 bg-emerald-50 text-emerald-800",
        dot: "bg-emerald-600",
      };
    case "completed":
      return {
        label: "Pending approval",
        className: "border-amber-200 bg-amber-50 text-amber-800",
        dot: "bg-amber-600",
      };
    case "rejected":
      return {
        label: "Rejected",
        className: "border-rose-200 bg-rose-50 text-rose-800",
        dot: "bg-rose-600",
      };
    case "failed":
      return {
        label: "Failed",
        className: "border-rose-200 bg-rose-50 text-rose-800",
        dot: "bg-rose-600",
      };
    case "processing":
      return {
        label: "Processing",
        className: "border-violet-200 bg-violet-50 text-violet-800",
        dot: "bg-violet-600",
      };
    default:
      return {
        label: "Draft",
        className: "border-slate-200 bg-slate-50 text-slate-700",
        dot: "bg-slate-500",
      };
  }
}

function ApprovalPill({ item }: { item: SavedCaseRecord }) {
  const pill = getApprovalPill(item);
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[13px] font-medium ${pill.className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${pill.dot}`} />
      {pill.label}
    </span>
  );
}

function getReconciliationText(item: SavedCaseRecord) {
  if (item.status === "draft")
    return { label: "Not checked", className: "text-slate-500" };
  if (item.status === "processing")
    return { label: "Checking…", className: "text-violet-700" };
  if (item.status === "failed")
    return { label: "No result", className: "text-rose-700" };
  if (item.mismatchCount > 0)
    return {
      label: `${item.mismatchCount} issue${item.mismatchCount === 1 ? "" : "s"}`,
      className: "font-semibold text-[#8b1d1d]",
    };
  return { label: "No issues", className: "text-emerald-700" };
}

function ReconciliationText({ item }: { item: SavedCaseRecord }) {
  const text = getReconciliationText(item);
  return (
    <span className={`whitespace-nowrap text-sm ${text.className}`}>
      {text.label}
    </span>
  );
}

function getCompanyName(item: SavedCaseRecord) {
  return (
    item.receiverName || item.buyerName || item.category || "Receiver pending"
  );
}

function toReadableCaseText(value: string) {
  return value
    .split(/(\/)/)
    .map((part) => {
      if (part === "/") return part;
      return part
        .split(/(\s+)/)
        .map((word) => {
          if (!word.trim()) return word;
          if (/[0-9]/.test(word)) return word;
          if (word.length <= 3 && word === word.toUpperCase()) return word;
          return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join("");
    })
    .join("")
    .replace(/\s+packet$/i, " packet");
}

function getCustomerName(item: SavedCaseRecord) {
  if (item.receiverName || item.buyerName)
    return toReadableCaseText(getCompanyName(item));
  return toReadableCaseText(item.displayName);
}

function getInvoiceLabel(item: SavedCaseRecord) {
  return item.invoiceNumber || item.poNumber || "—";
}

function FilterSelect<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <label className="relative flex h-10 min-w-0 flex-1 items-center">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="h-10 w-full cursor-pointer appearance-none rounded-lg border border-[#e2dbd1] bg-white pl-3 pr-9 text-sm text-[#1f2937] shadow-sm outline-none focus:border-[#b9aa99]"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 h-4 w-4 text-[#6b7280]" />
    </label>
  );
}

const HEADINGS = [
  { label: "Customer Name", className: "" },
  { label: "Invoice", className: "" },
  { label: "Approval", className: "" },
  { label: "Reconciliation", className: "" },
  { label: "Docs", className: "text-center" },
  { label: "Date", className: "" },
  { label: "Action", className: "text-right" },
];

function CasesTableHeader() {
  return (
    <TableHeader>
      <TableRow className="border-[#e7e0d6] hover:bg-transparent">
        {HEADINGS.map((heading) => (
          <TableHead
            key={heading.label}
            className={`h-11 px-0 pr-4 text-sm font-medium text-[#1f2937] last:pr-0 ${heading.className}`}
          >
            {heading.label}
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}

function CasesTableSkeleton({ rows }: { rows: number }) {
  return (
    <Table className="min-w-[900px]">
      <CasesTableHeader />
      <TableBody>
        {Array.from({ length: rows }).map((_, index) => (
          <TableRow key={index} className="h-[52px] border-[#ece6dc]">
            <TableCell className="px-0 pr-4">
              <Skeleton className="h-4 w-48 bg-[#eee7dd]" />
            </TableCell>
            <TableCell className="px-0 pr-4">
              <Skeleton className="h-3.5 w-24 bg-[#eee7dd]" />
            </TableCell>
            <TableCell className="px-0 pr-4">
              <Skeleton className="h-6 w-32 rounded-full bg-[#eee7dd]" />
            </TableCell>
            <TableCell className="px-0 pr-4">
              <Skeleton className="h-3.5 w-16 bg-[#eee7dd]" />
            </TableCell>
            <TableCell className="px-0 pr-4">
              <Skeleton className="mx-auto h-3.5 w-5 bg-[#eee7dd]" />
            </TableCell>
            <TableCell className="px-0 pr-4">
              <Skeleton className="h-3.5 w-20 bg-[#eee7dd]" />
            </TableCell>
            <TableCell className="px-0">
              <Skeleton className="ml-auto h-3.5 w-14 bg-[#eee7dd]" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CasesMobileCards({
  cases,
  onDelete,
}: {
  cases: SavedCaseRecord[];
  onDelete: (item: SavedCaseRecord) => void;
}) {
  const router = useRouter();

  return (
    <div className="grid grid-cols-1 gap-3 py-4 sm:grid-cols-2">
      {cases.map((item) => (
        <Link
          key={item.id}
          href={`/cases/${item.id}`}
          className="rounded-xl border border-[#e6ded2] bg-white p-4 shadow-sm transition hover:shadow-md"
          onFocus={() => {
            router.prefetch(`/cases/${item.id}`);
            warmCaseDetail(item.id);
          }}
          onMouseEnter={() => {
            router.prefetch(`/cases/${item.id}`);
            warmCaseDetail(item.id);
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-[#111827]">
                {getCustomerName(item)}
              </div>
              <div className="mt-1 truncate text-xs text-[#596579]">
                {getInvoiceLabel(item)}
              </div>
            </div>
            <button
              type="button"
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
              aria-label="Move to recycle bin"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDelete(item);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-[#596579]">
            <ApprovalPill item={item} />
            <ReconciliationText item={item} />
            <span>{item.documentCount} docs</span>
            <span>{formatDate(item.createdAt)}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}

export function CasesPage() {
  const router = useRouter();
  const [cases, setCases] = useState<SavedCaseRecord[]>([]);
  const [status, setStatus] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [approvalFilter, setApprovalFilter] = useState<ApprovalFilter>("all");
  const [reconciliationFilter, setReconciliationFilter] =
    useState<ReconciliationFilter>("all");
  const [showFilters, setShowFilters] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [pendingCase, setPendingCase] = useState<SavedCaseRecord | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const listQuery = useMemo<CaseListQuery>(
    () => ({
      query: debouncedSearchQuery,
      approval: approvalFilter,
      reconciliation: reconciliationFilter,
      page: currentPage,
      pageSize,
    }),
    [
      approvalFilter,
      currentPage,
      debouncedSearchQuery,
      pageSize,
      reconciliationFilter,
    ],
  );
  const cacheKey = useMemo(() => getCaseListCacheKey(listQuery), [listQuery]);
  const hasActiveFilters =
    Boolean(debouncedSearchQuery) ||
    approvalFilter !== "all" ||
    reconciliationFilter !== "all";

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim());
      setCurrentPage(1);
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [searchQuery]);

  useEffect(() => {
    const cached = caseListCache.get(cacheKey);
    let active = true;
    let latest = cached?.cases ?? [];
    let inFlight = false;
    if (cached) {
      setCases(cached.cases);
      setTotalCount(cached.totalCount);
      setTotalPages(cached.totalPages);
      setStatus("ready");
    } else {
      setCases([]);
      setTotalCount(0);
      setTotalPages(1);
      setStatus("loading");
    }
    setError(null);
    const refresh = async () => {
      if (inFlight || !active) return;
      inFlight = true;
      try {
        const payload = await fetchCaseListOnce(cacheKey, listQuery);
        if (!active) return;
        latest = payload.cases;
        setCases(latest);
        setTotalCount(payload.totalCount);
        setTotalPages(payload.totalPages);
        setStatus("ready");
        setError(null);
      } catch (loadError) {
        if (!active) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load cases.",
        );
        if (!latest.length) setStatus("error");
      } finally {
        inFlight = false;
      }
    };
    // Cached rows provide an immediate view, but returning from a review always refreshes decisions.
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        latest.some((item) => item.status === "processing")
      )
        void refresh();
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [cacheKey, listQuery]);

  async function handleConfirmDelete() {
    if (!pendingCase) return;

    try {
      setIsDeleting(true);
      setError(null);
      await recycleCase(pendingCase.id);
      // Other cached pages and filters now have stale counts.
      caseListCache.clear();
      const nextTotalCount = Math.max(0, totalCount - 1);
      const nextTotalPages = Math.max(1, Math.ceil(nextTotalCount / pageSize));

      setCases((current) =>
        current.filter((item) => item.id !== pendingCase.id),
      );
      setTotalCount(nextTotalCount);
      setTotalPages(nextTotalPages);
      if (currentPage > nextTotalPages) {
        setCurrentPage(nextTotalPages);
      }
      setPendingCase(null);
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Failed to move case to the recycle bin.",
      );
    } finally {
      setIsDeleting(false);
    }
  }

  function prefetchCase(caseId: string) {
    router.prefetch(`/cases/${caseId}`);
    warmCaseDetail(caseId);
  }

  return (
    <AppShell>
      <div className="min-h-full bg-[#f7f4ef] px-4 py-6 text-[#111827] sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-[1540px] flex-col">
          <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-baseline gap-2">
              <h1 className="text-xl font-semibold tracking-[-0.01em] text-[#111827]">
                Cases
              </h1>
              <span className="hidden text-sm text-[#8a8174] sm:inline">
                · Track and manage all cases
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowFilters((value) => !value)}
                className="h-9 rounded-lg border-[#e2dbd1] bg-white px-3 text-sm font-medium text-[#1f2937] hover:bg-[#fbfaf8]"
              >
                <Filter className="h-4 w-4" />
                {showFilters ? "Hide Filters" : "Show Filters"}
              </Button>
              <Button
                asChild
                className="h-9 rounded-lg bg-[#2b1a10] px-3 text-sm font-medium text-white hover:bg-[#3b271a]"
              >
                <Link href="/workspace">
                  <Plus className="h-4 w-4" />
                  Add Case
                </Link>
              </Button>
            </div>
          </header>

          {showFilters && (
            <div className="mt-5 flex flex-col gap-3 border-b border-[#e7e0d6] pb-3 md:flex-row">
              <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#e2dbd1] bg-white px-3 shadow-sm focus-within:border-[#b9aa99]">
                <Search className="h-4 w-4 shrink-0 text-[#8b94a4]" />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search case, buyer, invoice or PO..."
                  className="min-w-0 flex-1 bg-transparent text-sm text-[#111827] outline-none placeholder:text-[#9aa1ad]"
                />
              </label>
              <FilterSelect
                label="Approval state"
                value={approvalFilter}
                options={APPROVAL_OPTIONS}
                onChange={(value) => {
                  setApprovalFilter(value);
                  setCurrentPage(1);
                }}
              />
              <FilterSelect
                label="Reconciliation"
                value={reconciliationFilter}
                options={RECONCILIATION_OPTIONS}
                onChange={(value) => {
                  setReconciliationFilter(value);
                  setCurrentPage(1);
                }}
              />
            </div>
          )}

          {error && status !== "error" && (
            <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          )}

          <section className="mt-4">
            {status === "loading" && (
              <div className="overflow-x-auto">
                <CasesTableSkeleton rows={pageSize} />
              </div>
            )}

            {status === "error" && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm font-medium text-rose-700">
                {error}
              </div>
            )}

            {status === "ready" && cases.length === 0 && (
              <div className="flex min-h-[340px] flex-col items-center justify-center px-6 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-[#e6ded2] bg-white text-[#9c8f80]">
                  <FolderOpen className="h-7 w-7" />
                </div>
                <h2 className="text-lg font-medium text-[#111827]">
                  {hasActiveFilters ? "No matching cases" : "No cases yet"}
                </h2>
                <p className="mt-2 max-w-sm text-sm text-[#667085]">
                  {hasActiveFilters
                    ? "Try changing the search or filters."
                    : "Add your first packet to create a case."}
                </p>
                {!hasActiveFilters && (
                  <Button
                    asChild
                    className="mt-5 rounded-lg bg-[#2b1a10] font-medium text-white hover:bg-[#3b271a]"
                  >
                    <Link href="/workspace">Add Case</Link>
                  </Button>
                )}
              </div>
            )}

            {status === "ready" && cases.length > 0 && (
              <>
                <div className="md:hidden">
                  <CasesMobileCards cases={cases} onDelete={setPendingCase} />
                </div>
                <div className="hidden overflow-x-auto md:block">
                  <Table className="min-w-[900px]">
                    <CasesTableHeader />
                    <TableBody>
                      {cases.map((item) => (
                        <TableRow
                          key={item.id}
                          className="h-[52px] border-[#ece6dc] hover:bg-[#f1ece4]/60"
                        >
                          <TableCell className="max-w-[320px] px-0 py-2 pr-4">
                            <Link
                              href={`/cases/${item.id}`}
                              className="block truncate text-sm font-medium text-[#111827] hover:underline"
                              title={getCustomerName(item)}
                              onFocus={() => prefetchCase(item.id)}
                              onMouseEnter={() => prefetchCase(item.id)}
                            >
                              {getCustomerName(item)}
                            </Link>
                          </TableCell>
                          <TableCell className="max-w-[200px] truncate px-0 py-2 pr-4 text-sm text-[#4b5563]">
                            {getInvoiceLabel(item)}
                          </TableCell>
                          <TableCell className="px-0 py-2 pr-4">
                            <ApprovalPill item={item} />
                          </TableCell>
                          <TableCell className="px-0 py-2 pr-4">
                            <ReconciliationText item={item} />
                          </TableCell>
                          <TableCell className="px-0 py-2 pr-4 text-center text-sm text-[#4b5563]">
                            {item.documentCount}
                          </TableCell>
                          <TableCell className="whitespace-nowrap px-0 py-2 pr-4 text-sm text-[#4b5563]">
                            {formatDate(item.createdAt)}
                          </TableCell>
                          <TableCell className="px-0 py-2 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <Link
                                href={`/cases/${item.id}`}
                                className="rounded-md px-1.5 py-1 text-sm font-semibold text-[#111827] hover:bg-[#ebe4da]"
                                onFocus={() => prefetchCase(item.id)}
                                onMouseEnter={() => prefetchCase(item.id)}
                              >
                                View
                              </Link>
                              <button
                                type="button"
                                className="rounded-md p-1.5 text-[#8a8f98] transition hover:bg-rose-50 hover:text-rose-700"
                                aria-label="Move to recycle bin"
                                onClick={() => setPendingCase(item)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}

            {status === "ready" && totalCount > 0 && (
              <div className="flex flex-col gap-3 py-5 text-sm text-[#4b5563] sm:flex-row sm:items-center sm:justify-between">
                <label className="flex items-center gap-2">
                  Rows per page:
                  <span className="relative inline-flex items-center">
                    <select
                      value={pageSize}
                      onChange={(event) => {
                        setPageSize(Number(event.target.value));
                        setCurrentPage(1);
                      }}
                      className="h-8 cursor-pointer appearance-none rounded-lg border border-[#e2dbd1] bg-white pl-3 pr-8 text-sm text-[#1f2937] outline-none focus:border-[#b9aa99]"
                    >
                      {PAGE_SIZE_OPTIONS.map((size) => (
                        <option key={size} value={size}>
                          {size}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-[#6b7280]" />
                  </span>
                </label>
                <div className="flex items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 rounded-lg border-[#e2dbd1] bg-white px-3 text-sm text-[#1f2937] hover:bg-[#fbfaf8]"
                    disabled={currentPage <= 1}
                    onClick={() =>
                      setCurrentPage((page) => Math.max(1, page - 1))
                    }
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </Button>
                  <span className="whitespace-nowrap">
                    Page {currentPage} of {totalPages}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 rounded-lg border-[#e2dbd1] bg-white px-3 text-sm text-[#1f2937] hover:bg-[#fbfaf8]"
                    disabled={currentPage >= totalPages}
                    onClick={() =>
                      setCurrentPage((page) => Math.min(totalPages, page + 1))
                    }
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </section>
        </div>

        <CaseConfirmDialog
          open={Boolean(pendingCase)}
          onOpenChange={(open) => {
            if (!open && !isDeleting) {
              setPendingCase(null);
            }
          }}
          title="Move case to recycle bin?"
          description={
            pendingCase
              ? `"${pendingCase.displayName}" will be removed from the active cases list and moved to the recycle bin.`
              : ""
          }
          confirmLabel="Move to recycle bin"
          loading={isDeleting}
          onConfirm={handleConfirmDelete}
        />
      </div>
    </AppShell>
  );
}
