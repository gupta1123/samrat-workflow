"use client";
import { apiFetch } from "@/lib/api-client";
import { fetchCasePage, type SavedCaseRecord } from "@/lib/case-persistence";
import { getCaseDisplayStatus } from "@/lib/case-status";
import {
  Activity,
  ArrowRight,
  Building2,
  CalendarDays,
  Database,
  FileText,
  FolderOpen,
  Plus,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "./AppShell";

type DashboardData = {
  cases: SavedCaseRecord[];
  totalCases: number;
  counts: Record<string, number>;
};

// The dashboard reads recent active cases once and derives every figure from them.
const DASHBOARD_CASE_LIMIT = 500;
const CHART_DAYS = 15;
const RECENT_CASE_COUNT = 8;

let pendingDashboardLoad: Promise<DashboardData> | null = null;

function fetchDashboardData() {
  if (pendingDashboardLoad) return pendingDashboardLoad;

  const request = Promise.all([
    fetchCasePage({ scope: "active", limit: DASHBOARD_CASE_LIMIT, page: 1 }),
    apiFetch("/api/cases/summary"),
  ])
    .then(async ([page, response]) => {
      if (!response.ok) {
        throw new Error("Unable to load your workspace. Please retry.");
      }
      const counts = (await response.json()) as Record<string, number>;
      return {
        cases: page.cases,
        totalCases: counts.total ?? page.totalCount ?? page.cases.length,
        counts,
      };
    })
    .finally(() => {
      if (pendingDashboardLoad === request) pendingDashboardLoad = null;
    });

  pendingDashboardLoad = request;
  return request;
}

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function buildDailyVolume(cases: SavedCaseRecord[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: CHART_DAYS }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (CHART_DAYS - 1 - index));
    return { key: dayKey(date), date, count: 0 };
  });
  const byKey = new Map(days.map((day) => [day.key, day]));
  for (const item of cases) {
    const day = byKey.get(dayKey(new Date(item.createdAt)));
    if (day) day.count += 1;
  }
  return days;
}

function hasAnalysis(item: SavedCaseRecord) {
  return ["completed", "accepted", "rejected"].includes(item.status);
}

function riskLabel(score: number) {
  if (score < 34) return "Low risk";
  if (score < 67) return "Medium risk";
  return "High risk";
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

function formatShortDate(date: Date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function StatCard({
  icon: Icon,
  label,
  value,
  suffix,
  tone = "neutral",
  loading,
  aside,
}: {
  icon: typeof FileText;
  label: string;
  value: string | number;
  suffix?: React.ReactNode;
  tone?: "neutral" | "danger";
  loading: boolean;
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col justify-between rounded-2xl border border-[#e6ded2] bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <span
          className={`flex h-8 w-8 items-center justify-center rounded-lg border ${tone === "danger" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-[#e6ded2] bg-white text-[#2b1a10]"}`}
        >
          <Icon className="h-4 w-4" />
        </span>
        {aside}
      </div>
      <div className="mt-8 text-sm text-[#4b5563]">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        {loading ? (
          <span className="h-7 w-14 animate-pulse rounded bg-[#eee7dd]" />
        ) : (
          <span
            className={`text-2xl font-bold tabular-nums ${tone === "danger" ? "text-[#8b1d1d]" : "text-[#111827]"}`}
          >
            {value}
          </span>
        )}
        {!loading && suffix}
      </div>
    </div>
  );
}

function RiskRing({ value }: { value: number }) {
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      viewBox="0 0 44 44"
      className="h-11 w-11"
      role="img"
      aria-label={`${value}% average risk`}
    >
      <circle
        cx="22"
        cy="22"
        r={radius}
        fill="none"
        stroke="#efe9e1"
        strokeWidth="4"
      />
      <circle
        cx="22"
        cy="22"
        r={radius}
        fill="none"
        stroke="#2f6b4f"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${(value / 100) * circumference} ${circumference}`}
        transform="rotate(-90 22 22)"
      />
      <text
        x="22"
        y="25"
        textAnchor="middle"
        className="fill-[#111827] text-[10px] font-semibold"
      >
        {value}%
      </text>
    </svg>
  );
}

function CaseVolumeChart({
  days,
  loading,
}: {
  days: ReturnType<typeof buildDailyVolume>;
  loading: boolean;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(4, ...days.map((day) => day.count));
  const ticks = Array.from({ length: 5 }, (_, index) =>
    Math.round((max / 4) * (4 - index)),
  );
  const total = days.reduce((sum, day) => sum + day.count, 0);

  return (
    <section className="rounded-2xl border border-[#e6ded2] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#efe9e1] pb-4">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-[0.04em] text-[#111827]">
            Case volume by day (last {CHART_DAYS} days)
          </h2>
          <p className="mt-0.5 text-xs text-[#6b7280]">
            New cases added each day · {total} in total
          </p>
        </div>
      </div>

      <div className="mt-5 flex gap-3">
        <div className="flex h-[150px] flex-col justify-between pb-0 text-right text-[11px] tabular-nums text-[#6b7280]">
          {ticks.map((tick) => (
            <span key={tick} className="-translate-y-1/2 leading-none">
              {tick}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative h-[150px]">
            {ticks.map((tick, index) => (
              <div
                key={tick}
                className="absolute inset-x-0 border-t border-[#f0ebe4]"
                style={{ top: `${(index / 4) * 100}%` }}
              />
            ))}
            <div className="absolute inset-0 flex items-end gap-[2px]">
              {days.map((day, index) => (
                <div
                  key={day.key}
                  className="relative flex h-full flex-1 cursor-default items-end justify-center"
                  onMouseEnter={() => setHovered(index)}
                  onMouseLeave={() => setHovered(null)}
                >
                  {!loading && (
                    <div
                      className={`w-full max-w-[40px] rounded-t-[4px] transition-colors ${hovered === index ? "bg-[#4a2f1e]" : "bg-[#2b1a10]"}`}
                      style={{
                        height: day.count
                          ? `${(day.count / max) * 100}%`
                          : "2px",
                        opacity: day.count ? 1 : 0.15,
                      }}
                    />
                  )}
                  {hovered === index && (
                    <div className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-md border border-[#e6ded2] bg-white px-2 py-1 text-xs text-[#111827] shadow-md">
                      <span className="text-[#6b7280]">
                        {formatShortDate(day.date)}
                      </span>{" "}
                      <span className="font-semibold">
                        {day.count} case{day.count === 1 ? "" : "s"}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="mt-2 flex gap-[2px] text-[11px] text-[#6b7280]">
            {days.map((day, index) => (
              <span
                key={day.key}
                className={`flex-1 truncate text-center ${index % 2 === 1 ? "hidden sm:block" : ""}`}
              >
                {formatShortDate(day.date)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function statusChip(item: SavedCaseRecord) {
  const status = getCaseDisplayStatus(item.status);
  const styles =
    status.tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : status.tone === "danger"
        ? "border-rose-200 bg-rose-50 text-rose-800"
        : status.tone === "warning"
          ? "border-amber-200 bg-amber-50 text-amber-800"
          : "border-slate-200 bg-slate-50 text-slate-700";
  const dot =
    status.tone === "success"
      ? "bg-emerald-600"
      : status.tone === "danger"
        ? "bg-rose-600"
        : status.tone === "warning"
          ? "bg-amber-600"
          : "bg-slate-500";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${styles}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {status.label}
    </span>
  );
}

function RecentCaseCard({ item }: { item: SavedCaseRecord }) {
  const company = toReadableText(
    item.receiverName || item.buyerName || item.displayName,
  );
  const reference = item.invoiceNumber
    ? `Inv: ${item.invoiceNumber}`
    : item.poNumber
      ? `PO: ${item.poNumber}`
      : toReadableText(item.displayName);
  return (
    <Link
      href={`/cases/${item.id}`}
      className="flex flex-col rounded-2xl border border-[#e6ded2] bg-white p-4 transition hover:border-[#d6cbbc] hover:shadow-sm"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#e6ded2] bg-white text-[#5b4b3d]">
          <Building2 className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[#111827]">
            {company}
          </div>
          <div className="truncate text-xs text-[#6b7280]">{reference}</div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {statusChip(item)}
        <span className="rounded-md border border-[#e6ded2] px-1.5 py-0.5 text-xs text-[#4b5563]">
          {item.documentCount} docs
        </span>
        {item.mismatchCount > 0 && (
          <span className="rounded-md border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-xs font-medium text-rose-800">
            {item.mismatchCount} issue{item.mismatchCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="mt-3 flex items-center gap-1.5 border-t border-[#efe9e1] pt-3 text-xs text-[#6b7280]">
        <CalendarDays className="h-3.5 w-3.5" />
        {formatDate(item.createdAt)}
      </div>
    </Link>
  );
}

export function DashboardHome() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      setData(await fetchDashboardData());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load workspace.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const cases = useMemo(() => data?.cases ?? [], [data]);
  const stats = useMemo(() => {
    const analyzed = cases.filter(hasAnalysis);
    const averageRisk = analyzed.length
      ? Math.round(
          analyzed.reduce((sum, item) => sum + item.riskScore, 0) /
            analyzed.length,
        )
      : 0;
    return {
      documents: cases.reduce((sum, item) => sum + item.documentCount, 0),
      issues: cases.reduce((sum, item) => sum + item.mismatchCount, 0),
      averageRisk,
      days: buildDailyVolume(cases),
    };
  }, [cases]);
  const recent = cases.slice(0, RECENT_CASE_COUNT);

  return (
    <AppShell>
      <div className="min-h-full bg-[#f7f4ef] px-4 py-6 pb-28 text-[#111827] sm:px-6 md:pb-8 lg:px-8">
        <div className="mx-auto flex w-full max-w-[1540px] flex-col">
          <header className="flex flex-col gap-3 border-b border-[#e7e0d6] pb-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-baseline gap-2">
              <h1 className="text-xl font-semibold tracking-[-0.01em]">
                Dashboard
              </h1>
              <span className="hidden text-sm text-[#8a8174] sm:inline">
                · Case analytics and document health
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/cases"
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#e2dbd1] bg-white px-3 text-sm font-medium text-[#1f2937] hover:bg-[#fbfaf8]"
              >
                <FolderOpen className="h-4 w-4" />
                All Cases
              </Link>
              <Link
                href="/workspace"
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#2b1a10] px-3 text-sm font-medium text-white hover:bg-[#3b271a]"
              >
                <Plus className="h-4 w-4" />
                Add Case
              </Link>
            </div>
          </header>

          {error ? (
            <div
              role="alert"
              className="mt-5 rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800"
            >
              {error}
              <button onClick={load} className="ml-3 underline">
                Retry
              </button>
            </div>
          ) : (
            <>
              <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  icon={FileText}
                  label="Active Documents"
                  value={stats.documents}
                  loading={loading}
                  suffix={
                    <span className="rounded bg-[#efe6da] px-1.5 py-0.5 text-[11px] font-medium text-[#5b4b3d]">
                      Live
                    </span>
                  }
                />
                <StatCard
                  icon={Database}
                  label="Total Cases"
                  value={data?.totalCases ?? 0}
                  loading={loading}
                  suffix={
                    <span className="text-xs text-[#6b7280]">tracked</span>
                  }
                />
                <StatCard
                  icon={Activity}
                  label="Discovered Issues"
                  value={stats.issues}
                  tone={stats.issues > 0 ? "danger" : "neutral"}
                  loading={loading}
                  suffix={
                    stats.issues > 0 ? (
                      <span className="rounded border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[11px] font-medium text-rose-800">
                        Action needed
                      </span>
                    ) : (
                      <span className="text-xs text-emerald-700">
                        All clear
                      </span>
                    )
                  }
                />
                <StatCard
                  icon={TrendingUp}
                  label="Average Risk Index"
                  value={`${stats.averageRisk}%`}
                  loading={loading}
                  aside={!loading && <RiskRing value={stats.averageRisk} />}
                  suffix={
                    <span className="text-xs text-[#6b7280]">
                      {riskLabel(stats.averageRisk)}
                    </span>
                  }
                />
              </div>

              <div className="mt-4">
                <CaseVolumeChart days={stats.days} loading={loading} />
              </div>

              <section className="mt-6">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-bold uppercase tracking-[0.04em]">
                      Recent cases
                    </h2>
                    {!loading && (
                      <span className="rounded-full bg-[#efe6da] px-2 py-0.5 text-[11px] font-medium text-[#5b4b3d]">
                        {recent.length} recent
                      </span>
                    )}
                  </div>
                  <Link
                    href="/cases"
                    className="inline-flex items-center gap-1 text-sm font-semibold text-[#111827] hover:underline"
                  >
                    View all directory
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>

                {loading ? (
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {Array.from({ length: 4 }).map((_, index) => (
                      <div
                        key={index}
                        className="h-[150px] animate-pulse rounded-2xl border border-[#e6ded2] bg-white"
                      />
                    ))}
                  </div>
                ) : recent.length ? (
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {recent.map((item) => (
                      <RecentCaseCard key={item.id} item={item} />
                    ))}
                  </div>
                ) : (
                  <div className="mt-3 rounded-2xl border border-[#e6ded2] bg-white p-12 text-center">
                    <FileText className="mx-auto h-9 w-9 text-[#c9bfb2]" />
                    <h3 className="mt-4 font-medium">No cases yet</h3>
                    <p className="mt-2 text-sm text-[#6b7280]">
                      Your documents and review history will appear here.
                    </p>
                    <Link
                      href="/workspace"
                      className="mt-5 inline-block text-sm font-semibold text-[#2b1a10] underline"
                    >
                      Add your first case
                    </Link>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
