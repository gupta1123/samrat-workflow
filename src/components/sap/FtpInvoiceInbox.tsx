"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-client";
import type {
  FtpInvoicePage,
  FtpInvoiceProgress,
  FtpInvoiceStatus,
} from "@/lib/ftp-invoice-inbox";

const statuses: Record<FtpInvoiceStatus, string> = {
  copying: "Waiting for upload",
  ready: "Ready to analyze",
  queued: "Queued",
  importing: "Importing",
  analyzing: "Analyzing",
  failed: "Needs attention",
  archive_pending: "Archive pending",
  archived: "Ready for review",
  missing: "Removed from FTP",
};
const dateTime = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

export function FtpInvoiceInbox() {
  const router = useRouter();
  const [data, setData] = useState<FtpInvoicePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingInvoice, setPendingInvoice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const query = new URLSearchParams({
          page: String(page),
          q: search.trim(),
        });
        const response = await apiFetch(`/api/ftp-invoice-inbox?${query}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error ?? "Could not load the invoice inbox.");
        if (!controller.signal.aborted) {
          setData(body);
          setError(null);
        }
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load the invoice inbox.",
          );
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(read, 10_000);
      }
    }
    timer = setTimeout(read, search ? 250 : 0);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [page, refresh, search]);

  useEffect(() => {
    if (!pendingInvoice) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failedChecks = 0;

    function stopWaiting(message: string) {
      setActionError(message);
      setPendingInvoice(null);
      setRefresh((value) => value + 1);
    }

    async function checkProgress() {
      try {
        const response = await apiFetch(
          `/api/ftp-invoice-inbox?id=${pendingInvoice}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (controller.signal.aborted) return;
        if (response.status === 401 || response.status === 404) {
          stopWaiting(
            response.status === 401
              ? "Your session expired. Sign in to open the case."
              : "The invoice is no longer available in your inbox.",
          );
          return;
        }
        if (!response.ok) throw new Error("Analysis status is unavailable.");
        const progress: FtpInvoiceProgress = await response.json();
        if (controller.signal.aborted) return;
        failedChecks = 0;
        if (
          progress.caseId &&
          ["analyzing", "archive_pending", "archived"].includes(progress.status)
        ) {
          router.replace(`/cases/${progress.caseId}`);
          return;
        }
        if (progress.status === "failed" || progress.status === "missing") {
          stopWaiting(progress.error ?? "The invoice could not be analyzed.");
          return;
        }
      } catch {
        if (controller.signal.aborted) return;
        if (++failedChecks >= 3) {
          stopWaiting(
            "Could not check progress. Refresh the inbox for the latest status.",
          );
          return;
        }
      }
      timer = setTimeout(checkProgress, 3_000);
    }

    void checkProgress();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pendingInvoice, router]);

  async function analyze(id: string) {
    setBusy(id);
    setActionError(null);
    try {
      const response = await apiFetch("/api/ftp-invoice-inbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const body = await response.json();
      if (!response.ok || !body.queued)
        throw new Error(body.error ?? "Could not queue the invoice.");
      setPendingInvoice(id);
      setData(
        (previous) =>
          previous && {
            ...previous,
            rows: previous.rows.map((row) =>
              row.id === id
                ? { ...row, status: "queued", canAnalyze: false, error: null }
                : row,
            ),
          },
      );
    } catch (failure) {
      setActionError(
        failure instanceof Error
          ? failure.message
          : "Could not queue the invoice.",
      );
    } finally {
      setBusy(null);
      setRefresh((value) => value + 1);
    }
  }

  return (
    <section aria-label="Non-material invoice inbox" className="mt-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex min-w-0 items-center gap-2 rounded-lg border border-[#ded5c9] bg-white px-3 py-2 text-sm sm:w-80">
          <Search className="h-4 w-4 shrink-0 text-[#71675e]" aria-hidden />
          <input
            aria-label="Search invoice file names"
            placeholder="Search file names"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            className="w-full bg-transparent outline-none"
          />
        </label>
        <div className="flex items-center gap-3">
          <p className="text-xs text-[#71675e]">
            {data?.lastSuccessAt
              ? `FTP checked ${dateTime.format(new Date(data.lastSuccessAt))} IST`
              : "Waiting for the first FTP check"}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Refresh
          </Button>
        </div>
      </div>
      {pendingInvoice && (
        <p role="status" className="text-sm text-[#64564b]">
          Preparing the PDF. The analysis page will open automatically.
        </p>
      )}
      {(error || actionError || data?.connectionError) && (
        <p
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {error || actionError || data?.connectionError}
        </p>
      )}
      <div className="overflow-x-auto rounded-xl border border-[#ded5c9] bg-white">
        <table className="w-full min-w-[620px] text-left text-sm">
          <thead className="border-b border-[#e8e0d6] bg-[#f4eee7] text-[#64564b]">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                PDF file
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                First seen
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Status
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((row) => (
              <tr
                key={row.id}
                className="border-b border-[#eee8e0] last:border-0"
              >
                <td className="px-4 py-3">
                  <span className="flex items-start gap-2 break-all font-medium">
                    <FileText
                      className="mt-0.5 h-4 w-4 shrink-0 text-[#71675e]"
                      aria-hidden
                    />
                    {row.fileName}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-[#64564b]">
                  {dateTime.format(new Date(row.discoveredAt))}
                </td>
                <td className="px-4 py-3">
                  <span className="rounded-full bg-[#f4eee7] px-2 py-1 text-xs font-medium text-[#6b3d20]">
                    {statuses[row.status]}
                  </span>
                  {row.error && (
                    <p className="mt-1 max-w-xs text-xs text-[#71675e]">
                      {row.error}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {row.canAnalyze && (
                      <Button
                        size="sm"
                        disabled={busy !== null || pendingInvoice !== null}
                        onClick={() => void analyze(row.id)}
                        className="bg-[#6b3d20] text-white hover:bg-[#543019]"
                      >
                        {busy === row.id
                          ? "Queuing…"
                          : row.status === "failed"
                            ? "Retry"
                            : "Analyze"}
                      </Button>
                    )}
                    {row.caseId && (
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/cases/${row.caseId}`}>Open case</Link>
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!data?.rows.length && (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-8 text-center text-[#71675e]"
                >
                  {!data && !error
                    ? "Loading invoices…"
                    : error
                      ? "Invoice inbox is unavailable."
                      : search
                        ? "No files match your search."
                        : "No PDFs have been found yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data && data.totalPages > 1 && (
        <nav
          aria-label="Invoice inbox pages"
          className="flex justify-end gap-3"
        >
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((value) => value - 1)}
          >
            Previous
          </Button>
          <span className="self-center text-sm text-[#71675e]">
            {page} / {data.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= data.totalPages}
            onClick={() => setPage((value) => value + 1)}
          >
            Next
          </Button>
        </nav>
      )}
    </section>
  );
}
