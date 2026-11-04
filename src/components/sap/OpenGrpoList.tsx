"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Loader2, RefreshCw, Search } from "lucide-react";

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

const HEAD =
  "sticky top-0 z-10 bg-[#f3efe9] px-3 py-2.5 text-left text-xs font-semibold text-[#6b6157]";
const CELL = "px-3 py-2.5 align-top";

function Dash() {
  return <span className="text-[#b5aa9d]">—</span>;
}

function Quantity({
  value,
  line,
  strong = false,
}: {
  value: number | null;
  line: SapInspectorLine;
  strong?: boolean;
}) {
  if (value === null)
    return <span className="text-xs text-[#9a8f84]">Not returned</span>;
  const unit = unitOf(line);
  return (
    <span
      className={`tabular-nums ${strong ? "text-[15px] font-semibold text-[#17130f]" : ""}`}
    >
      {qty(value)}
      {unit ? (
        <span className="ml-1 text-xs font-normal text-[#81766b]">{unit}</span>
      ) : null}
    </span>
  );
}

function MoreInfo({ record }: { record: SapInspectorRecord }) {
  const refs = referencesOf(record);
  const facts: Array<[string, string]> = [
    ["E-way bill", refs.eWayBill.join(", ")],
    ["LR no.", refs.lorryReceipt.join(", ")],
    ["Warehouse", uniq(record.lines.map((line) => line.warehouse)).join(", ")],
    ["SAP entry", record.docEntry ?? ""],
    ["Note", record.comments ?? ""],
  ].filter(([, value]) => value) as Array<[string, string]>;
  return (
    <div className="space-y-4 px-3 py-4">
      <table className="w-full max-w-xl text-sm">
        <thead className="text-xs text-[#81766b]">
          <tr>
            <th className="pb-1.5 pr-3 text-left font-medium">Item</th>
            <th className="pb-1.5 pr-3 text-right font-medium">GRPO rate</th>
            <th className="pb-1.5 text-right font-medium">PO rate</th>
          </tr>
        </thead>
        <tbody>
          {record.lines.map((line, index) => {
            const currency =
              typeof line.raw.Currency === "string" ? line.raw.Currency : "";
            const rate = (value: number | null | undefined) =>
              value == null
                ? "—"
                : [currency, money.format(value)].join(" ").trim();
            return (
              <tr key={index} className="border-t border-[#ece6de]">
                <td className="py-1.5 pr-3">{itemName(line, index)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {rate(line.price)}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {line.linkedPoPrice == null
                    ? "—"
                    : money.format(line.linkedPoPrice)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {facts.length ? (
        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {facts.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs text-[#81766b]">{label}</dt>
              <dd className="break-words font-mono text-[#2b231d]">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <details className="text-xs text-[#81766b]">
        <summary className="cursor-pointer select-none">Show SAP data</summary>
        <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-[#201c19] p-3 font-mono text-[11px] leading-4 text-[#eee7dc]">
          {JSON.stringify(record.raw, null, 2)}
        </pre>
      </details>
    </div>
  );
}

/** One GRPO: shared columns span its item rows, quantities stay per item. */
function GrpoRows({ record }: { record: SapInspectorRecord }) {
  const [open, setOpen] = useState(false);
  const refs = referencesOf(record);
  const date = dateParts(record.date);
  const span = Math.max(record.lines.length, 1);
  const lines = record.lines.length ? record.lines : [null];
  return (
    <tbody className="border-t-2 border-[#e2dacf] first:border-t-0">
      {lines.map((line, index) => {
        const done = line !== null && line.openQuantity === 0;
        return (
          <tr
            key={index}
            className={`${index > 0 ? "border-t border-[#f0ebe3]" : ""} ${done ? "text-[#9a8f84]" : ""}`}
          >
            {index === 0 ? (
              <>
                <td
                  rowSpan={span}
                  className={`${CELL} border-r border-[#f0ebe3]`}
                >
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-label={`${open ? "Hide" : "Show"} more about GRPO ${record.docNumber ?? ""}`}
                    onClick={() => setOpen((value) => !value)}
                    className="flex items-center gap-1 font-mono text-[15px] font-semibold text-[#6b3d20] hover:underline"
                  >
                    <ChevronRight
                      className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`}
                    />
                    {record.docNumber ?? "—"}
                  </button>
                  {date ? (
                    <div className="mt-0.5 pl-5 text-xs text-[#81766b]">
                      {date.label}
                      <span className="text-[#b5aa9d]"> · {date.age}</span>
                    </div>
                  ) : null}
                </td>
                <td rowSpan={span} className={`${CELL} max-w-[240px]`}>
                  <div className="break-words font-medium text-[#17130f]">
                    {record.vendorName ?? "—"}
                  </div>
                  {record.vendorCode ? (
                    <div className="font-mono text-xs text-[#81766b]">
                      {record.vendorCode}
                    </div>
                  ) : null}
                </td>
                <td rowSpan={span} className={`${CELL} font-mono`}>
                  {refs.invoice.length ? (
                    refs.invoice.join(", ")
                  ) : (
                    <span className="font-sans text-xs text-amber-700">
                      Not entered
                    </span>
                  )}
                </td>
                <td
                  rowSpan={span}
                  className={`${CELL} border-r border-[#f0ebe3] font-mono`}
                >
                  {refs.truck.length ? refs.truck.join(", ") : <Dash />}
                </td>
              </>
            ) : null}
            <td className={`${CELL} font-mono`}>
              {line?.linkedPoNumber ?? <Dash />}
            </td>
            <td className={`${CELL} max-w-[300px]`}>
              {line ? (
                <>
                  <div className="break-words">{itemName(line, index)}</div>
                  {line.itemCode && line.description ? (
                    <div className="font-mono text-xs text-[#9a8f84]">
                      {line.itemCode}
                    </div>
                  ) : null}
                </>
              ) : (
                <Dash />
              )}
            </td>
            <td className={`${CELL} text-right`}>
              {line ? <Quantity value={line.quantity} line={line} /> : <Dash />}
            </td>
            <td className={`${CELL} text-right`}>
              {line ? (
                <Quantity
                  value={line.openQuantity}
                  line={line}
                  strong={!done}
                />
              ) : (
                <Dash />
              )}
            </td>
          </tr>
        );
      })}
      {open ? (
        <tr className="border-t border-[#f0ebe3] bg-[#fbfaf8]">
          <td colSpan={8} className="p-0">
            <MoreInfo record={record} />
          </td>
        </tr>
      ) : null}
    </tbody>
  );
}

function SkeletonRows() {
  return (
    <tbody>
      {[0, 1, 2, 3, 4].map((row) => (
        <tr key={row} className="border-t border-[#f0ebe3]">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((cell) => (
            <td key={cell} className={CELL}>
              <Skeleton className="h-4 w-full max-w-[120px]" />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
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

      <div className="mt-4 overflow-x-auto rounded-xl border border-[#e2dacf] bg-white">
        <table
          className="w-full min-w-[1000px] border-collapse text-sm"
          aria-busy={loading}
        >
          <thead>
            <tr>
              <th className={HEAD}>GRPO</th>
              <th className={HEAD}>Supplier</th>
              <th className={HEAD}>Invoice no.</th>
              <th className={`${HEAD} border-r border-[#e2dacf]`}>Truck</th>
              <th className={HEAD}>PO no.</th>
              <th className={HEAD}>Item</th>
              <th className={`${HEAD} text-right`}>Received</th>
              <th className={`${HEAD} text-right`}>Left to bill</th>
            </tr>
          </thead>
          {loading ? (
            <SkeletonRows />
          ) : (
            stillOpen.map((record) => (
              <GrpoRows key={record.id} record={record} />
            ))
          )}
        </table>
      </div>

      {data && !loading && !stillOpen.length && !error ? (
        <p className="mt-10 text-center text-sm text-[#81766b]">
          {data.nextCursor !== null
            ? "No remaining quantities on this page. Choose Older to keep looking."
            : search
              ? "Nothing found. Try another word."
              : "No open GRPOs on this page."}
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
