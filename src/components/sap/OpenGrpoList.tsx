"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { SapInspectorLine, SapInspectorRecord } from "@/lib/sap-inspector";
import type { GrpoInspectorPage } from "@/lib/sap-grpo-inspector";

const PAGE_SIZE = 25;
const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 6 });
const money = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

const qty = (value: number | null) =>
  value === null ? "—" : number.format(value);

function unitOf(line: SapInspectorLine) {
  const unit = line.raw.UoMCode ?? line.raw.MeasureUnit;
  return typeof unit === "string" ? unit.trim() : "";
}

function itemName(line: SapInspectorLine, index: number) {
  return line.description || line.itemCode || `Item ${index + 1}`;
}

function isOpen(line: SapInspectorLine) {
  return (line.openQuantity ?? 0) > 0;
}

function uniq(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => !!value))];
}

function dateParts(value: string | null) {
  const day = value?.slice(0, 10);
  const parsed = day ? new Date(`${day}T00:00:00`) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return null;
  const days = Math.max(
    0,
    Math.floor((Date.now() - parsed.getTime()) / 86_400_000),
  );
  return {
    label: parsed.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }),
    age: days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`,
  };
}

/** Everything a person looks for on a receipt, gathered from header and lines. */
function referencesOf(record: SapInspectorRecord) {
  const refs = record.lines.map((line) => line.matchReferences);
  const all = (key: "invoice" | "eWayBill" | "lorryReceipt" | "vehicle") =>
    uniq([record.matchReferences?.[key], ...refs.map((ref) => ref?.[key])]);
  return {
    po: uniq(record.lines.map((line) => line.linkedPoNumber)),
    invoice: all("invoice"),
    truck: all("vehicle"),
    eWayBill: all("eWayBill"),
    lorryReceipt: all("lorryReceipt"),
  };
}

function Chip({ label, values }: { label: string; values: string[] }) {
  if (!values.length) return null;
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-[#f3eee6] px-2.5 py-1 text-xs">
      <span className="text-[#81766b]">{label}</span>
      <span className="truncate font-mono font-medium text-[#2b231d]">
        {values.join(", ")}
      </span>
    </span>
  );
}

function LeftBar({ line }: { line: SapInspectorLine }) {
  const total = line.quantity;
  const left = line.openQuantity;
  const billedShare =
    total && total > 0 && left !== null
      ? Math.min(100, Math.max(0, ((total - left) / total) * 100))
      : null;
  const unit = unitOf(line);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5">
      <div className="min-w-0 text-sm text-[#2b231d]">
        <span className="line-clamp-2 break-words">{itemName(line, 0)}</span>
      </div>
      <div className="text-right">
        <span className="text-base font-semibold tabular-nums text-[#17130f]">
          {left === null ? "Not returned" : qty(left)}
        </span>
        {left !== null ? (
          <span className="ml-1 text-xs text-[#6b6157]">{unit} left</span>
        ) : null}
        {total !== null ? (
          <span className="ml-1.5 text-xs tabular-nums text-[#9a8f84]">
            of {qty(total)}
          </span>
        ) : null}
      </div>
      {billedShare !== null ? (
        <div
          className="col-span-2 h-1.5 overflow-hidden rounded-full bg-[#ece5da]"
          role="img"
          aria-label={`${Math.round(billedShare)}% billed`}
        >
          <div
            className="h-full rounded-full bg-[#6b3d20]"
            style={{ width: `${billedShare}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

function Details({ record }: { record: SapInspectorRecord }) {
  const refs = referencesOf(record);
  const facts: Array<[string, string]> = [
    ["E-way bill", refs.eWayBill.join(", ")],
    ["LR no.", refs.lorryReceipt.join(", ")],
    ["Warehouse", uniq(record.lines.map((line) => line.warehouse)).join(", ")],
    ["SAP entry", record.docEntry ?? ""],
    ["Note", record.comments ?? ""],
  ];
  return (
    <div className="border-t border-[#ece6de] bg-[#fbfaf8] px-4 py-4 sm:px-5">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[460px] text-left text-sm">
          <thead className="text-xs text-[#81766b]">
            <tr>
              <th className="pb-2 pr-3 font-medium">Item</th>
              <th className="pb-2 pr-3 text-right font-medium">Received</th>
              <th className="pb-2 pr-3 text-right font-medium">Left</th>
              <th className="pb-2 text-right font-medium">Rate</th>
            </tr>
          </thead>
          <tbody>
            {record.lines.map((line, index) => {
              const rateDiffers =
                line.price !== null &&
                line.linkedPoPrice != null &&
                Math.abs(line.price - line.linkedPoPrice) > 0.005;
              return (
                <tr
                  key={`${line.lineNumber ?? index}`}
                  className={`border-t border-[#ece6de] align-top ${
                    isOpen(line) ? "" : "text-[#9a8f84]"
                  }`}
                >
                  <td className="py-2 pr-3">
                    {itemName(line, index)}
                    {line.itemCode && line.description ? (
                      <div className="font-mono text-xs text-[#9a8f84]">
                        {line.itemCode}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {qty(line.quantity)}
                  </td>
                  <td className="py-2 pr-3 text-right font-medium tabular-nums">
                    {line.openQuantity === null
                      ? "Not returned"
                      : qty(line.openQuantity)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {line.price !== null
                      ? [line.raw.Currency, money.format(line.price)]
                          .filter((value) => typeof value === "string" && value)
                          .join(" ")
                      : "—"}
                    {rateDiffers ? (
                      <div className="text-xs text-amber-700">
                        PO rate {money.format(line.linkedPoPrice as number)}
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {facts
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-[#81766b]">{label}</dt>
              <dd className="break-words font-mono text-[#2b231d]">{value}</dd>
            </div>
          ))}
      </dl>
      <details className="mt-4 text-xs text-[#81766b]">
        <summary className="cursor-pointer select-none">Show SAP data</summary>
        <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-[#201c19] p-3 font-mono text-[11px] leading-4 text-[#eee7dc]">
          {JSON.stringify(record.raw, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function ReceiptCard({ record }: { record: SapInspectorRecord }) {
  const [open, setOpen] = useState(false);
  const refs = referencesOf(record);
  const date = dateParts(record.date);
  const openLines = record.lines.filter(isOpen);
  const shown = record.lines.filter(
    (line) => isOpen(line) || line.openQuantity === null,
  );
  const billedLines = record.lines.filter(
    (line) => line.openQuantity === 0,
  ).length;
  return (
    <li className="overflow-hidden rounded-xl border border-[#e2dacf] bg-white shadow-[0_1px_0_rgba(23,19,15,0.03)]">
      <div className="px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <h2 className="break-words text-base font-semibold text-[#17130f]">
              {record.vendorName ?? record.vendorCode ?? "Unknown supplier"}
            </h2>
            <p className="mt-0.5 text-xs text-[#81766b]">
              {record.vendorCode ? (
                <span className="font-mono">{record.vendorCode}</span>
              ) : null}
            </p>
          </div>
          <div className="text-right text-sm">
            <div className="font-mono font-semibold text-[#6b3d20]">
              GRPO {record.docNumber ?? "—"}
            </div>
            {date ? (
              <div className="text-xs text-[#81766b]">
                {date.label} · {date.age}
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Chip label="PO" values={refs.po} />
          <Chip label="Invoice" values={refs.invoice} />
          <Chip label="Truck" values={refs.truck} />
          {!refs.invoice.length ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-800">
              <AlertCircle className="h-3 w-3" />
              No invoice no.
            </span>
          ) : null}
        </div>

        <ul className="mt-4 space-y-4 border-t border-[#f0ebe3] pt-4">
          {shown.map((line, index) => (
            <li key={`${line.lineNumber ?? index}`}>
              <LeftBar line={{ ...line, description: itemName(line, index) }} />
            </li>
          ))}
        </ul>
        {billedLines > 0 && openLines.length ? (
          <p className="mt-3 text-xs text-[#9a8f84]">
            {billedLines} other {billedLines === 1 ? "item is" : "items are"} at
            zero remaining quantity.
          </p>
        ) : null}
      </div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-center gap-1.5 border-t border-[#ece6de] bg-[#fbfaf8] py-2 text-xs font-medium text-[#6b3d20] hover:bg-[#f4efe8]"
      >
        {open ? "Hide details" : "Details"}
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? <Details record={record} /> : null}
    </li>
  );
}

function CardSkeleton() {
  return (
    <li className="rounded-xl border border-[#e2dacf] bg-white p-5">
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="mt-3 h-4 w-2/3" />
      <Skeleton className="mt-6 h-4 w-full" />
      <Skeleton className="mt-2 h-1.5 w-full" />
    </li>
  );
}

export function OpenGrpoList() {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<Array<number | null>>([null]);
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<GrpoInspectorPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cursor = cursors[page];

  // Search while typing, without a request for every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = text.trim();
      if (next === search) return;
      setSearch(next);
      setPage(0);
      setCursors([null]);
    }, 400);
    return () => clearTimeout(timer);
  }, [text, search]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setData(null);
    setError(null);
    setLoading(true);
    const params = new URLSearchParams({
      q: search,
      supplier: "",
      status: "open",
      limit: String(PAGE_SIZE),
    });
    if (cursor !== null) params.set("before", String(cursor));
    void (async () => {
      try {
        const response = await apiFetch(`/api/sap-inspector/grpos?${params}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Could not read SAP.");
        if (!Array.isArray(body.records))
          throw new Error("SAP sent an unexpected answer.");
        if (active) setData(body);
      } catch (failure) {
        if (active && !controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : "Could not read SAP.",
          );
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [search, cursor, refresh]);

  const stillOpen = useMemo(
    () =>
      data?.records.filter((record) =>
        record.lines.some((line) => isOpen(line) || line.openQuantity === null),
      ) ?? [],
    [data],
  );

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex h-11 min-w-0 flex-[1_1_280px] items-center gap-2 rounded-xl border border-[#ddd4c8] bg-white px-3.5 focus-within:border-[#b9a78f] focus-within:ring-4 focus-within:ring-[#6b3d20]/10">
          <Search className="h-4 w-4 shrink-0 text-[#9a8f84]" />
          <input
            aria-label="Search open GRPOs"
            placeholder="Search supplier, invoice, truck or GRPO no."
            maxLength={100}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[#9a8f84]"
          />
        </label>
        <Button
          variant="outline"
          className="h-11 rounded-xl border-[#ddd4c8] bg-white px-4 text-sm"
          disabled={loading}
          onClick={() => {
            setPage(0);
            setCursors([null]);
            setRefresh((value) => value + 1);
          }}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Refresh
        </Button>
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
        >
          <span>{error}</span>
          <Button
            variant="outline"
            className="h-9 bg-white"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Try again
          </Button>
        </div>
      ) : null}

      <ul className="mt-4 space-y-4" aria-busy={loading}>
        {loading
          ? [0, 1, 2].map((key) => <CardSkeleton key={key} />)
          : stillOpen.map((record) => (
              <ReceiptCard key={record.id} record={record} />
            ))}
      </ul>

      {data && !loading && !stillOpen.length && !error ? (
        <p className="mt-10 text-center text-sm text-[#81766b]">
          {search ? "Nothing found. Try another word." : "No open GRPOs."}
        </p>
      ) : null}

      {data && (page > 0 || data.nextCursor !== null) ? (
        <div className="mt-5 flex items-center justify-between text-sm text-[#81766b]">
          <Button
            variant="outline"
            className="h-9 bg-white"
            disabled={page === 0 || loading}
            onClick={() => setPage((value) => value - 1)}
          >
            Newer
          </Button>
          <span>Page {page + 1}</span>
          <Button
            variant="outline"
            className="h-9 bg-white"
            disabled={data.nextCursor === null || loading}
            onClick={() => {
              setCursors((current) => [
                ...current.slice(0, page + 1),
                data.nextCursor,
              ]);
              setPage((value) => value + 1);
            }}
          >
            Older
          </Button>
        </div>
      ) : null}
    </section>
  );
}
