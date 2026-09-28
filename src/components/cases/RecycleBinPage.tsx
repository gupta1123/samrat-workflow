"use client";

import {
  ChevronLeft,
  ChevronRight,
  Clock,
  RotateCcw,
  Search,
  Trash,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

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
  deleteCaseForever,
  fetchCasePage,
  restoreCase,
  type SavedCaseRecord,
} from "@/lib/case-persistence";

type LoadState = "loading" | "ready" | "error";
type PendingAction =
  | { type: "destroy"; item: SavedCaseRecord }
  | { type: "restore"; item: SavedCaseRecord }
  | null;

const RECYCLE_BIN_PAGE_SIZE = 25;

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function toReadableText(value: string) {
  return value
    .split(/(\s+)/)
    .map((word) => {
      if (!word.trim() || /[0-9]/.test(word)) return word;
      if (word.length <= 3 && word === word.toUpperCase()) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join("");
}

function getCaseName(item: SavedCaseRecord) {
  return toReadableText(
    item.receiverName || item.buyerName || item.displayName || "Unnamed case",
  );
}

function getCaseReference(item: SavedCaseRecord) {
  if (item.invoiceNumber) return `Inv: ${item.invoiceNumber}`;
  if (item.poNumber) return `PO: ${item.poNumber}`;
  return null;
}

function getCategory(item: SavedCaseRecord) {
  return toReadableText(item.category || item.displayName || "—");
}

const HEADINGS = [
  { label: "Case / Document", className: "" },
  { label: "Category", className: "" },
  { label: "Deleted On", className: "" },
  { label: "Retention", className: "" },
  { label: "Actions", className: "text-right" },
];

function RecycleBinTableHeader() {
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

function RecycleBinTableSkeleton() {
  return (
    <Table className="min-w-[860px]">
      <RecycleBinTableHeader />
      <TableBody>
        {Array.from({ length: 8 }).map((_, index) => (
          <TableRow key={index} className="h-[52px] border-[#ece6dc]">
            <TableCell className="px-0 pr-4">
              <Skeleton className="h-3.5 w-48 bg-[#eee7dd]" />
              <Skeleton className="mt-1.5 h-3 w-28 bg-[#eee7dd]" />
            </TableCell>
            <TableCell className="px-0 pr-4">
              <Skeleton className="h-3.5 w-36 bg-[#eee7dd]" />
            </TableCell>
            <TableCell className="px-0 pr-4">
              <Skeleton className="h-3.5 w-20 bg-[#eee7dd]" />
            </TableCell>
            <TableCell className="px-0 pr-4">
              <Skeleton className="h-6 w-28 rounded-full bg-[#eee7dd]" />
            </TableCell>
            <TableCell className="px-0">
              <Skeleton className="ml-auto h-3.5 w-24 bg-[#eee7dd]" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// Samrat has no automatic purge, so retention is shown instead of an expiry countdown.
function RetentionPill() {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[#e2dbd1] bg-white px-2.5 py-0.5 text-[13px] font-medium text-[#4b5563]">
      <Clock className="h-3.5 w-3.5" />
      Until deleted
    </span>
  );
}

function RowActions({
  item,
  onAction,
}: {
  item: SavedCaseRecord;
  onAction: (action: PendingAction) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-sm font-medium text-emerald-700 transition hover:bg-emerald-50"
        onClick={() => onAction({ type: "restore", item })}
      >
        <RotateCcw className="h-3.5 w-3.5" />
        Restore
      </button>
      <button
        type="button"
        className="rounded-md p-1.5 text-[#8a8f98] transition hover:bg-rose-50 hover:text-rose-700"
        aria-label="Delete permanently"
        onClick={() => onAction({ type: "destroy", item })}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

export function RecycleBinPage() {
  const [cases, setCases] = useState<SavedCaseRecord[]>([]);
  const [status, setStatus] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [isMutating, setIsMutating] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
      setCurrentPage(1);
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();

    setStatus("loading");
    setError(null);

    fetchCasePage({
      scope: "deleted",
      limit: RECYCLE_BIN_PAGE_SIZE,
      page: currentPage,
      query: debouncedQuery,
      signal: controller.signal,
    })
      .then((payload) => {
        setCases(payload.cases);
        setTotalCount(payload.totalCount ?? payload.cases.length);
        setTotalPages(payload.totalPages ?? 1);
        setStatus("ready");
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load recycle bin.",
        );
        setStatus("error");
      });

    return () => {
      controller.abort();
    };
  }, [currentPage, debouncedQuery]);

  const pageStart =
    totalCount === 0 ? 0 : (currentPage - 1) * RECYCLE_BIN_PAGE_SIZE + 1;
  const pageEnd = Math.min(currentPage * RECYCLE_BIN_PAGE_SIZE, totalCount);

  async function handleConfirmAction() {
    if (!pendingAction) return;

    try {
      setIsMutating(true);
      setError(null);

      if (pendingAction.type === "restore") {
        await restoreCase(pendingAction.item.id);
      } else {
        await deleteCaseForever(pendingAction.item.id);
      }

      setCases((current) =>
        current.filter((item) => item.id !== pendingAction.item.id),
      );
      const nextTotalCount = Math.max(0, totalCount - 1);
      const nextTotalPages = Math.max(
        1,
        Math.ceil(nextTotalCount / RECYCLE_BIN_PAGE_SIZE),
      );
      setTotalCount(nextTotalCount);
      setTotalPages(nextTotalPages);
      if (currentPage > nextTotalPages) {
        setCurrentPage(nextTotalPages);
      }
      setPendingAction(null);
    } catch (mutationError) {
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Failed to update recycle bin.",
      );
    } finally {
      setIsMutating(false);
    }
  }

  return (
    <AppShell>
      <div className="min-h-full bg-[#f7f4ef] px-4 py-6 text-[#111827] sm:px-6 lg:px-8">
        <div className="mx-auto flex w-full max-w-[1540px] flex-col">
          <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-baseline gap-2">
              <h1 className="text-xl font-semibold tracking-[-0.01em] text-[#111827]">
                Recycle Bin
              </h1>
              <span className="hidden text-sm text-[#8a8174] sm:inline">
                · Manage and restore deleted cases
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#e2dbd1] bg-white px-3 text-sm font-medium text-[#4b5563]">
                <Trash2 className="h-4 w-4" />
                Kept until you delete them
              </span>
              <Button
                asChild
                variant="outline"
                className="h-9 rounded-lg border-[#e2dbd1] bg-white px-3 text-sm font-medium text-[#1f2937] hover:bg-[#fbfaf8]"
              >
                <Link href="/cases">All Cases</Link>
              </Button>
            </div>
          </header>

          <div className="mt-5 border-b border-[#e7e0d6] pb-3">
            <label className="flex h-10 w-full max-w-md items-center gap-2 rounded-lg border border-[#e2dbd1] bg-white px-3 shadow-sm focus-within:border-[#b9aa99]">
              <Search className="h-4 w-4 shrink-0 text-[#8b94a4]" />
              <input
                type="text"
                placeholder="Search deleted cases, buyers, or numbers..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-sm text-[#111827] outline-none placeholder:text-[#9aa1ad]"
              />
            </label>
          </div>

          {error && status !== "error" && (
            <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          )}

          <section className="mt-4">
            {status === "loading" && (
              <div className="overflow-x-auto">
                <RecycleBinTableSkeleton />
              </div>
            )}

            {status === "error" && (
              <div className="flex items-start rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
                <Trash className="mr-3 mt-0.5 h-5 w-5 shrink-0 text-rose-500" />
                <div>
                  <div className="mb-1 font-medium">
                    Failed to load recycle bin
                  </div>
                  <div>{error}</div>
                </div>
              </div>
            )}

            {status === "ready" && totalCount === 0 && (
              <div className="flex min-h-[340px] flex-col items-center justify-center px-6 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-[#e6ded2] bg-white text-[#9c8f80]">
                  {debouncedQuery ? (
                    <Search className="h-7 w-7" />
                  ) : (
                    <Trash2 className="h-7 w-7" />
                  )}
                </div>
                <h2 className="text-lg font-medium text-[#111827]">
                  {debouncedQuery
                    ? "No matching cases"
                    : "Recycle Bin is empty"}
                </h2>
                <p className="mt-2 max-w-sm text-sm text-[#667085]">
                  {debouncedQuery
                    ? `No deleted cases match "${debouncedQuery}".`
                    : "Deleted cases stay here until you restore or permanently delete them."}
                </p>
                {debouncedQuery && (
                  <Button
                    variant="link"
                    onClick={() => setQuery("")}
                    className="mt-2 font-medium text-[#2b1a10]"
                  >
                    Clear search
                  </Button>
                )}
              </div>
            )}

            {status === "ready" && cases.length > 0 && (
              <>
                <div className="grid grid-cols-1 gap-3 py-2 sm:grid-cols-2 md:hidden">
                  {cases.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-xl border border-[#e6ded2] bg-white p-4 shadow-sm"
                    >
                      <div className="truncate text-sm font-medium text-[#111827]">
                        {getCaseName(item)}
                      </div>
                      {getCaseReference(item) && (
                        <div className="mt-0.5 truncate text-xs text-[#6b7280]">
                          {getCaseReference(item)}
                        </div>
                      )}
                      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-[#596579]">
                        <span>Deleted {formatDate(item.deletedAt)}</span>
                        <RetentionPill />
                      </div>
                      <div className="mt-3">
                        <RowActions item={item} onAction={setPendingAction} />
                      </div>
                    </div>
                  ))}
                </div>

                <div className="hidden overflow-x-auto md:block">
                  <Table className="min-w-[860px]">
                    <RecycleBinTableHeader />
                    <TableBody>
                      {cases.map((item) => (
                        <TableRow
                          key={item.id}
                          className="h-[52px] border-[#ece6dc] hover:bg-[#f1ece4]/60"
                        >
                          <TableCell className="max-w-[340px] px-0 py-2 pr-4">
                            <div
                              className="truncate text-sm font-medium text-[#111827]"
                              title={getCaseName(item)}
                            >
                              {getCaseName(item)}
                            </div>
                            {getCaseReference(item) && (
                              <div className="mt-0.5 truncate text-xs text-[#6b7280]">
                                {getCaseReference(item)}
                              </div>
                            )}
                          </TableCell>
                          <TableCell
                            className="max-w-[220px] truncate px-0 py-2 pr-4 text-sm text-[#4b5563]"
                            title={getCategory(item)}
                          >
                            {getCategory(item)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap px-0 py-2 pr-4 text-sm text-[#4b5563]">
                            {formatDate(item.deletedAt)}
                          </TableCell>
                          <TableCell className="px-0 py-2 pr-4">
                            <RetentionPill />
                          </TableCell>
                          <TableCell className="px-0 py-2">
                            <RowActions
                              item={item}
                              onAction={setPendingAction}
                            />
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
                <div>
                  Showing {pageStart}–{pageEnd} of {totalCount}
                </div>
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
          open={Boolean(pendingAction)}
          onOpenChange={(open) => {
            if (!open && !isMutating) {
              setPendingAction(null);
            }
          }}
          title={
            pendingAction?.type === "restore"
              ? "Restore this case?"
              : "Delete this case permanently?"
          }
          description={
            pendingAction
              ? pendingAction.type === "restore"
                ? `"${pendingAction.item.displayName}" will be moved back into the active cases list.`
                : `"${pendingAction.item.displayName}" and its stored documents will be removed permanently. This cannot be undone.`
              : ""
          }
          confirmLabel={
            pendingAction?.type === "restore"
              ? "Restore case"
              : "Delete forever"
          }
          variant={pendingAction?.type === "restore" ? "default" : "danger"}
          loading={isMutating}
          onConfirm={handleConfirmAction}
        />
      </div>
    </AppShell>
  );
}
