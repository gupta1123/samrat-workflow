"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleX,
  Database,
  FileJson,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AppShell } from "@/components/dashboard/AppShell";
import { Button } from "@/components/ui/button";
import { BusinessPartnersTab } from "./BusinessPartnersTab";
import { GrpoInspectorTab } from "./GrpoInspectorTab";
import type {
  SapInspectorDataset,
  SapInspectorFinding,
  SapInspectorRecord,
  SapInspectorResponse,
} from "@/lib/sap-inspector";

type DatasetState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: SapInspectorResponse };

type RecordFilter = "all" | "open" | "issues";

const PAGE_SIZE = 25;
type InspectorTab = SapInspectorDataset | "business-partners";

const TABS: Array<{
  id: InspectorTab;
  label: string;
  description: string;
}> = [
  {
    id: "business-partners",
    label: "Business Partners",
    description: "SAP Business Partner master data",
  },
  {
    id: "open-po",
    label: "Open PO",
    description: "Operational OpenPO feed used by the legacy readiness flow",
  },
  {
    id: "po",
    label: "Purchase Orders",
    description: "PurchaseOrders read directly from SAP Business One",
  },
  {
    id: "grpo",
    label: "GRPO",
    description: "Goods receipts and their Purchase Order base links",
  },
  {
    id: "ap-invoice",
    label: "AP Invoices",
    description: "Posted PurchaseInvoices used for duplicate detection",
  },
];

function money(value: number | null, currency: string | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: currency && /^[A-Z]{3}$/.test(currency) ? "currency" : "decimal",
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : undefined,
    maximumFractionDigits: 2,
  }).format(value);
}

function dateLabel(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
}

function findingStyle(severity: SapInspectorFinding["severity"]) {
  if (severity === "blocked") {
    return {
      icon: CircleX,
      className: "border-rose-200 bg-rose-50 text-rose-800",
    };
  }
  if (severity === "warning") {
    return {
      icon: AlertTriangle,
      className: "border-amber-200 bg-amber-50 text-amber-800",
    };
  }
  return {
    icon: CheckCircle2,
    className: "border-emerald-200 bg-emerald-50 text-emerald-800",
  };
}

function Finding({ finding }: { finding: SapInspectorFinding }) {
  const style = findingStyle(finding.severity);
  const Icon = style.icon;
  return (
    <div className={`rounded-lg border px-3 py-2 ${style.className}`}>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div>
          <div className="text-[11px] font-semibold">{finding.title}</div>
          <div className="mt-0.5 text-[10px] leading-4 opacity-85">
            {finding.detail}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ record }: { record: SapInspectorRecord }) {
  const open = /open/i.test(record.status) && !record.cancelled;
  const className = record.cancelled
    ? "border-rose-200 bg-rose-50 text-rose-800"
    : open
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-semibold ${className}`}
    >
      {record.status}
    </span>
  );
}

export function RecordDetails({ record }: { record: SapInspectorRecord }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="border-t border-[#e7e0d6] bg-[#fbfaf8] px-4 py-4 lg:px-6">
      <div className="grid gap-4 xl:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.7fr)]">
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6f665d]">
            Why matching may fail
          </h3>
          <div className="mt-2 space-y-2">
            {record.findings.map((finding, index) => (
              <Finding
                key={`${finding.severity}:${finding.title}:${index}`}
                finding={finding}
              />
            ))}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
            <div>
              <dt className="text-[#8a8174]">DocEntry</dt>
              <dd className="font-mono text-[#29221d]">
                {record.docEntry ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-[#8a8174]">Branch</dt>
              <dd className="font-mono text-[#29221d]">
                {record.branchId ?? "—"}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-[#8a8174]">{record.dataset === "grpo" ? "Linked PO references" : "PO references SAP exposes"}</dt>
              <dd className="break-words font-mono text-[#29221d]">
                {record.poReferences.join(" · ") || "—"}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-[#8a8174]">Comments</dt>
              <dd className="break-words text-[#29221d]">
                {record.comments ?? "—"}
              </dd>
            </div>
          </dl>
          {record.matchReferences ? <dl className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
            {[["Vendor Invoice No.", record.matchReferences.invoice], ["E-way Bill No.", record.matchReferences.eWayBill], ["LR No.", record.matchReferences.lorryReceipt], ["Vehicle No.", record.matchReferences.vehicle], ["SAP vendor reference (NumAtCard)", record.vendorReference]].map(([label, value]) => <div key={label}><dt className="text-[#8a8174]">{label}</dt><dd className="break-words font-mono">{value ?? "—"}</dd></div>)}
            <p className="col-span-2 text-[10px] text-[#8a8174]">Header values shown here. Line overrides and the references used for matching appear in the line table.</p>
          </dl> : null}
        </section>

        <section className="min-w-0">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#6f665d]">
              SAP document lines ({record.lines.length})
            </h3>
            <button
              type="button"
              onClick={() => setShowRaw((value) => !value)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#ddd4c8] bg-white px-2 py-1 text-[10px] font-medium text-[#5f564d] hover:bg-[#f4efe8]"
            >
              <FileJson className="h-3 w-3" />
              {showRaw ? "Hide raw SAP JSON" : "Show raw SAP JSON"}
            </button>
          </div>
          {showRaw ? (
            <pre className="mt-2 max-h-[420px] overflow-auto rounded-lg border border-[#ded7cd] bg-[#201c19] p-4 font-mono text-[10px] leading-4 text-[#eee7dc]">
              {JSON.stringify(record.raw, null, 2)}
            </pre>
          ) : (
            <div className="mt-2 overflow-x-auto rounded-lg border border-[#e4ddd3] bg-white">
              <table className="min-w-[920px] w-full text-left text-[11px]">
                <thead className="bg-[#f4f0ea] text-[10px] uppercase tracking-[0.06em] text-[#766c61]">
                  <tr>
                    <th className="px-3 py-2">Line</th>
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2">Description</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Open</th>
                    <th className="px-3 py-2 text-right">{record.dataset === "grpo" ? "GRPO unit price" : "Price"}</th>
                    <th className="px-3 py-2">Warehouse</th>
                    <th className="px-3 py-2">Line status</th>
                    {record.dataset === "grpo" ? <><th className="px-3 py-2">Linked PO No.</th><th className="px-3 py-2">Matching references</th></> : null}
                    <th className="px-3 py-2">Base link</th>
                  </tr>
                </thead>
                <tbody>
                  {record.lines.map((line, index) => (
                    <tr
                      key={`${record.id}:line:${line.lineNumber ?? index}`}
                      className="border-t border-[#eee8df]"
                    >
                      <td className="px-3 py-2 font-mono">
                        {line.lineNumber ?? index}
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {line.itemCode ?? "—"}
                      </td>
                      <td className="max-w-[280px] truncate px-3 py-2" title={line.description ?? ""}>
                        {line.description ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {line.quantity ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {line.openQuantity ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {line.price ?? "—"}
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {line.warehouse ?? "—"}
                      </td>
                      <td className="px-3 py-2">{line.status?.replace(/^bost_/, "") ?? "Unknown"}</td>
                      {record.dataset === "grpo" ? <>
                        <td className="whitespace-nowrap px-3 py-2 font-mono">
                          {line.linkedPoNumber ?? (line.baseType === 22 && line.baseEntry !== null ? "PO not returned" : "No PO base link")}
                          {line.linkedPoNumber ? <div className="mt-1 space-y-0.5 text-[10px] text-[#8a8174]"><div>PO unit price: {line.linkedPoPrice ?? "—"}</div><div>PO quantity: {line.linkedPoQuantity ?? "—"}</div></div> : null}
                        </td>
                        <td className="min-w-[190px] px-3 py-2 text-[10px]">
                          {[["Invoice", line.matchReferences?.invoice], ["E-way bill", line.matchReferences?.eWayBill], ["LR", line.matchReferences?.lorryReceipt], ["Vehicle", line.matchReferences?.vehicle]].map(([label, value]) => <div key={label}><span className="text-[#8a8174]">{label}: </span><span className="font-mono">{value ?? "—"}</span></div>)}
                        </td>
                      </> : null}
                      <td className="whitespace-nowrap px-3 py-2 font-mono">
                        {line.baseEntry !== null
                          ? `${line.baseType ?? "?"} / ${line.baseEntry} / ${line.baseLine ?? "?"}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function recordSearchText(record: SapInspectorRecord) {
  return [
    record.docEntry,
    record.docNumber,
    record.vendorCode,
    record.vendorName,
    record.vendorReference,
    record.status,
    record.poReferences.join(" "),
    ...record.lines.flatMap((line) => [
      line.itemCode,
      line.description,
      line.baseEntry,
      line.baseLine,
    ]),
  ]
    .filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLocaleLowerCase("en-IN");
}

export function SapInspectorPage() {
  const [activeTab, setActiveTab] = useState<InspectorTab>("open-po");
  const [initialized, setInitialized] = useState(false);
  const [states, setStates] = useState<
    Partial<Record<SapInspectorDataset, DatasetState>>
  >({});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RecordFilter>("all");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async (dataset: SapInspectorDataset, force = false) => {
    setStates((current) => ({ ...current, [dataset]: { status: "loading" } }));
    try {
      const params = new URLSearchParams({ dataset, limit: "100" });
      if (force) params.set("refresh", "1");
      const response = await fetch(`/api/sap-inspector?${params}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      const body = (await response.json().catch(() => ({}))) as
        | SapInspectorResponse
        | { error?: string };
      if (!response.ok || !("records" in body)) {
        throw new Error(
          "error" in body && body.error
            ? body.error
            : `SAP returned HTTP ${response.status}.`,
        );
      }
      setStates((current) => ({
        ...current,
        [dataset]: { status: "ready", data: body },
      }));
    } catch (error) {
      setStates((current) => ({
        ...current,
        [dataset]: {
          status: "error",
          error:
            error instanceof Error ? error.message : "Could not read SAP data.",
        },
      }));
    }
  }, []);

  useEffect(() => {
    if (initialized && activeTab !== "business-partners" && activeTab !== "grpo" && !states[activeTab]) void load(activeTab);
  }, [activeTab, initialized, load, states]);

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get("tab");
    if (TABS.some((tab) => tab.id === initial)) setActiveTab(initial as InspectorTab);
    setInitialized(true);
  }, []);

  useEffect(() => {
    setPage(1);
    setExpanded(null);
  }, [activeTab, query, filter]);

  const activeState = activeTab === "business-partners" ? null : states[activeTab];
  const data = activeState?.status === "ready" ? activeState.data : null;
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("en-IN");
    return (data?.records ?? []).filter((record) => {
      const matchesQuery = !needle || recordSearchText(record).includes(needle);
      const hasIssues = record.findings.some(
        (finding) => finding.severity !== "ok",
      );
      const matchesFilter =
        filter === "all" ||
        (filter === "open" && /open/i.test(record.status) && !record.cancelled) ||
        (filter === "issues" && hasIssues);
      return matchesQuery && matchesFilter;
    });
  }, [data, filter, query]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const issueCount =
    data?.records.filter((record) =>
      record.findings.some((finding) => finding.severity !== "ok"),
    ).length ?? 0;
  const blockedCount =
    data?.records.filter((record) =>
      record.findings.some((finding) => finding.severity === "blocked"),
    ).length ?? 0;
  const openCount =
    data?.records.filter(
      (record) => /open/i.test(record.status) && !record.cancelled,
    ).length ?? 0;
  const tab = TABS.find((item) => item.id === activeTab)!;

  return (
    <AppShell defaultSidebarCollapsed>
      <div className="min-h-full bg-[#f7f4ef] px-4 py-6 text-[#17130f] sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-[1680px]">
          <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b5b35]">
                <Database className="h-3.5 w-3.5" /> Private diagnostic
              </div>
              <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em]">
                SAP Data Inspector
              </h1>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-[#71675e]">
                Read-only SAP records used by Samrat matching. Expand any row to
                see the base links, line values, raw response, and likely reasons
                a packet cannot find or use that record.
              </p>
            </div>
            {activeTab !== "business-partners" && activeTab !== "grpo" ? <div className="flex items-center gap-2">
              {data ? (
                <div className="text-right text-[10px] leading-4 text-[#897f74]">
                  <div>{data.source}</div>
                  <div>
                    {data.environment.toUpperCase()} · updated {dateLabel(data.fetchedAt)}
                  </div>
                </div>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={activeState?.status === "loading"}
                onClick={() => void load(activeTab, true)}
                className="h-9 rounded-lg border-[#ddd4c8] bg-white text-xs"
              >
                {activeState?.status === "loading" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Refresh SAP
              </Button>
            </div> : null}
          </header>

          <div className="mt-6 overflow-x-auto border-b border-[#ddd5ca]">
            <div className="flex min-w-max gap-1" role="tablist" aria-label="SAP datasets">
              {TABS.map((item) => {
                const state = item.id === "business-partners" ? null : states[item.id];
                const count = state?.status === "ready" ? state.data.records.length : null;
                const active = item.id === activeTab;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => {
                      setActiveTab(item.id);
                      const url = new URL(window.location.href);
                      url.searchParams.set("tab", item.id);
                      window.history.replaceState(null, "", url);
                    }}
                    className={`border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                      active
                        ? "border-[#6b3d20] text-[#3e2414]"
                        : "border-transparent text-[#786e64] hover:text-[#332a24]"
                    }`}
                  >
                    {item.label}
                    {count !== null ? (
                      <span className="ml-2 rounded-full bg-[#e9e2d9] px-2 py-0.5 text-[10px] text-[#62584e]">
                        {count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          {activeTab === "business-partners" ? <BusinessPartnersTab /> : activeTab === "grpo" ? <GrpoInspectorTab renderDetails={record => <RecordDetails record={record} />} /> : <>
          <div className="mt-4">
            <h2 className="text-sm font-semibold">{tab.label}</h2>
            <p className="mt-0.5 text-xs text-[#81766b]">{tab.description}</p>
          </div>

          {activeState?.status === "loading" || !activeState ? (
            <div className="mt-12 flex min-h-[360px] items-center justify-center rounded-xl border border-[#e4ddd3] bg-white">
              <div className="text-center text-sm text-[#7d7369]">
                <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin" />
                Reading actual SAP data…
              </div>
            </div>
          ) : null}

          {activeState?.status === "error" ? (
            <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800">
              <div className="font-semibold">SAP data could not be loaded</div>
              <div className="mt-1">{activeState.error}</div>
              <Button
                type="button"
                variant="outline"
                className="mt-4 h-8 border-rose-200 bg-white text-xs"
                onClick={() => void load(activeTab, true)}
              >
                <RefreshCw className="h-3.5 w-3.5" /> Retry
              </Button>
            </div>
          ) : null}

          {data ? (
            <>
              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  ["Records read", data.records.length, "text-[#322820]"],
                  ["Open", openCount, "text-emerald-700"],
                  ["Needs attention", issueCount, "text-amber-700"],
                  ["Blocked", blockedCount, "text-rose-700"],
                ].map(([label, value, color]) => (
                  <div key={String(label)} className="rounded-xl border border-[#e3dbd0] bg-white px-4 py-3 shadow-sm">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#887d72]">
                      {label}
                    </div>
                    <div className={`mt-1 text-2xl font-semibold ${color}`}>{value}</div>
                  </div>
                ))}
              </div>

              {data.truncated ? (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Showing the newest {data.limit} SAP records. Search applies to this loaded set.
                </div>
              ) : null}

              <div className="mt-4 flex flex-col gap-3 rounded-xl border border-[#e2dacf] bg-white p-3 md:flex-row md:items-center">
                <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#ddd4c8] bg-[#fbfaf8] px-3 focus-within:border-[#a9917d]">
                  <Search className="h-4 w-4 shrink-0 text-[#8b8177]" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search DocNum, DocEntry, vendor, invoice ref, PO ref or item…"
                    className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-[#a39a90]"
                  />
                </label>
                <div className="flex gap-1 rounded-lg bg-[#f2ede6] p-1">
                  {(
                    [
                      ["all", "All"],
                      ["open", "Open"],
                      ["issues", "Has match issue"],
                    ] as Array<[RecordFilter, string]>
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setFilter(value)}
                      className={`rounded-md px-3 py-1.5 text-[11px] font-medium ${
                        filter === value
                          ? "bg-white text-[#35291f] shadow-sm"
                          : "text-[#776d63]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-3 overflow-hidden rounded-xl border border-[#e1d9ce] bg-white shadow-sm">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1120px] text-left">
                    <thead className="bg-[#f3efe9] text-[10px] uppercase tracking-[0.07em] text-[#766c61]">
                      <tr>
                        <th className="w-9 px-3 py-3" aria-label="Expand" />
                        <th className="px-3 py-3">SAP document</th>
                        <th className="px-3 py-3">Vendor</th>
                        <th className="px-3 py-3">Vendor reference</th>
                        <th className="px-3 py-3">Date</th>
                        <th className="px-3 py-3 text-right">Total</th>
                        <th className="px-3 py-3 text-center">Lines</th>
                        <th className="px-3 py-3">Status</th>
                        <th className="px-3 py-3">Match reading</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((record) => {
                        const isExpanded = expanded === record.id;
                        const primaryFinding =
                          record.findings.find((finding) => finding.severity === "blocked") ??
                          record.findings.find((finding) => finding.severity === "warning") ??
                          record.findings[0];
                        const finding = findingStyle(primaryFinding.severity);
                        const FindingIcon = finding.icon;
                        return (
                          <tr key={record.id} className="border-t border-[#ece6de] align-top">
                            <td colSpan={9} className="p-0">
                              <button
                                type="button"
                                onClick={() => setExpanded(isExpanded ? null : record.id)}
                                className="grid w-full grid-cols-[36px_170px_210px_190px_110px_130px_64px_100px_minmax(240px,1fr)] items-center text-left hover:bg-[#fbf8f4]"
                              >
                                <span className="px-3 py-3 text-[#80756b]">
                                  {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                                </span>
                                <span className="px-3 py-3">
                                  <span className="block font-mono text-xs font-semibold text-[#2d241e]">
                                    {record.docNumber ?? "No DocNum"}
                                  </span>
                                  <span className="mt-0.5 block font-mono text-[9px] text-[#91877c]">
                                    Entry {record.docEntry ?? "—"}
                                  </span>
                                </span>
                                <span className="min-w-0 px-3 py-3">
                                  <span className="block truncate text-xs font-medium" title={record.vendorName ?? ""}>
                                    {record.vendorName ?? "Unknown vendor"}
                                  </span>
                                  <span className="mt-0.5 block font-mono text-[9px] text-[#91877c]">
                                    {record.vendorCode ?? "No CardCode"}
                                  </span>
                                </span>
                                <span className="truncate px-3 py-3 font-mono text-[11px]" title={record.vendorReference ?? ""}>
                                  {record.vendorReference ?? "—"}
                                </span>
                                <span className="px-3 py-3 text-[11px] text-[#5f564d]">
                                  {dateLabel(record.date)}
                                </span>
                                <span className="px-3 py-3 text-right font-mono text-[11px]">
                                  {money(record.total, record.currency)}
                                </span>
                                <span className="px-3 py-3 text-center font-mono text-[11px]">
                                  {record.lines.length}
                                </span>
                                <span className="px-3 py-3">
                                  <StatusPill record={record} />
                                </span>
                                <span className="px-3 py-3">
                                  <span className={`inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-medium ${finding.className}`}>
                                    <FindingIcon className="h-3 w-3 shrink-0" />
                                    <span className="truncate">{primaryFinding.title}</span>
                                  </span>
                                </span>
                              </button>
                              {isExpanded ? <RecordDetails record={record} /> : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {!visible.length ? (
                  <div className="flex min-h-[260px] flex-col items-center justify-center px-6 text-center">
                    <Search className="h-7 w-7 text-[#a59b90]" />
                    <div className="mt-3 text-sm font-semibold">No matching SAP records</div>
                    <div className="mt-1 text-xs text-[#82786e]">
                      Change the search or filter, or refresh SAP.
                    </div>
                  </div>
                ) : null}

                <footer className="flex flex-col gap-3 border-t border-[#e7e0d7] bg-[#fbfaf8] px-4 py-3 text-[11px] text-[#776d63] sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    Showing {visible.length ? (page - 1) * PAGE_SIZE + 1 : 0}–
                    {Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-7 border-[#ddd4c8] bg-white px-2 text-[10px]"
                      disabled={page <= 1}
                      onClick={() => setPage((value) => Math.max(1, value - 1))}
                    >
                      <ChevronLeft className="h-3 w-3" /> Previous
                    </Button>
                    <span className="font-mono">{page} / {totalPages}</span>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-7 border-[#ddd4c8] bg-white px-2 text-[10px]"
                      disabled={page >= totalPages}
                      onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                    >
                      Next <ChevronRight className="h-3 w-3" />
                    </Button>
                  </div>
                </footer>
              </div>
            </>
          ) : null}
          </>}
        </div>
      </div>
    </AppShell>
  );
}
