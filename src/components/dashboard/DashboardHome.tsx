"use client";
import { apiFetch } from "@/lib/api-client";
import { fetchRecentCases, type SavedCaseRecord } from "@/lib/case-persistence";
import { getCaseDisplayStatus } from "@/lib/case-status";
import {
  ArrowRight,
  Clock3,
  FileText,
  Loader2,
  Plus,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "./AppShell";

type DashboardData = {
  cases: SavedCaseRecord[];
  counts: Record<string, number>;
};

let pendingDashboardLoad: Promise<DashboardData> | null = null;

function fetchDashboardData() {
  if (pendingDashboardLoad) return pendingDashboardLoad;

  const request = Promise.all([
    fetchRecentCases(6),
    apiFetch("/api/cases/summary"),
  ])
    .then(async ([recent, response]) => {
      if (!response.ok) {
        throw new Error("Unable to load your workspace. Please retry.");
      }
      return {
        cases: recent.cases,
        counts: (await response.json()) as Record<string, number>,
      };
    })
    .finally(() => {
      if (pendingDashboardLoad === request) pendingDashboardLoad = null;
    });

  pendingDashboardLoad = request;
  return request;
}

export function DashboardHome() {
  const [cases, setCases] = useState<SavedCaseRecord[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function load() {
    setLoading(true);
    setError("");
    try {
      const dashboard = await fetchDashboardData();
      setCounts(dashboard.counts);
      setCases(dashboard.cases);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load workspace.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const cards = [
    { label: "All cases", value: counts.total, icon: FileText },
    { label: "Needs Review", value: counts.review, icon: TriangleAlert },
    { label: "Processing", value: counts.processing, icon: Clock3 },
    { label: "Approved", value: counts.accepted, icon: ShieldCheck },
  ];
  return (
    <AppShell>
      <div className="mx-auto max-w-6xl p-5 pb-28 sm:p-8 lg:p-10">
        <header className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
              Samrat Group / Case workspace
            </p>
            <h1 className="mt-3 text-3xl font-semibold text-slate-900 sm:text-4xl">
              Your review desk.
            </h1>
            <p className="mt-3 text-sm text-slate-500">
              Add documents, review the findings, and move each case forward.
            </p>
          </div>
          <Link
            href="/workspace"
            className="flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-3 text-sm font-medium text-white"
          >
            <Plus className="h-4 w-4" />
            New case
          </Link>
        </header>
        {error ? (
          <div
            role="alert"
            className="mt-8 rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800"
          >
            {error}
            <button onClick={load} className="ml-3 underline">
              Retry
            </button>
          </div>
        ) : (
          <div className="mt-9 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {cards.map((c) => (
              <div
                key={c.label}
                className="rounded-xl border border-slate-200 bg-white p-5"
              >
                <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                  {c.label}
                  <c.icon className="h-4 w-4" />
                </div>
                <div className="mt-5 text-3xl font-semibold tabular-nums text-slate-900">
                  {loading ? "—" : (c.value ?? 0)}
                </div>
              </div>
            ))}
          </div>
        )}
        <section className="mt-8 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between gap-4 border-b border-slate-100 p-5 sm:px-6">
            <h2 className="font-semibold text-slate-900">Recent cases</h2>
            <Link
              href="/cases"
              className="flex items-center gap-2 text-sm text-emerald-700"
            >
              View all
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          {loading ? (
            <div className="flex items-center gap-3 p-10 text-sm text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin" />
              Loading cases…
            </div>
          ) : cases.length ? (
            cases.map((c) => (
              <Link
                key={c.id}
                href={`/cases/${c.id}`}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-5 last:border-b-0 hover:bg-slate-50 sm:px-6"
              >
                <div className="flex min-w-0 items-center gap-4">
                  <div className="hidden rounded-lg bg-slate-100 p-3 sm:block">
                    <FileText className="h-5 w-5 text-slate-600" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium text-slate-900">
                      {c.displayName}
                    </h3>
                    <p className="mt-1 text-xs text-slate-500">
                      {c.documentCount} documents · {c.mismatchCount} issues ·{" "}
                      {new Date(c.createdAt).toLocaleDateString("en-IN")}
                    </p>
                  </div>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${getCaseDisplayStatus(c.status).tone === "success" ? "bg-emerald-50 text-emerald-800" : getCaseDisplayStatus(c.status).tone === "danger" ? "bg-rose-50 text-rose-800" : getCaseDisplayStatus(c.status).tone === "warning" ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-600"}`}
                >
                  {getCaseDisplayStatus(c.status).label}
                </span>
              </Link>
            ))
          ) : (
            <div className="p-12 text-center">
              <FileText className="mx-auto h-9 w-9 text-slate-300" />
              <h3 className="mt-4 font-medium">No cases yet</h3>
              <p className="mt-2 text-sm text-slate-500">
                Your documents and review history will appear here.
              </p>
              <Link
                href="/workspace"
                className="mt-5 inline-block text-sm font-medium text-emerald-700"
              >
                Create your first case →
              </Link>
            </div>
          )}
        </section>
        <div className="mt-7 rounded-xl bg-slate-900 p-6 text-white">
          <h2 className="font-medium">From documents to a clear decision</h2>
          <p className="mt-3 text-sm leading-7 text-slate-300">
            Upload a case → Extract and compare documents → Check mismatches →
            Accept or reject.
          </p>
          <p className="mt-2 text-xs leading-6 text-slate-400">
            Automated findings are suggestions. Check original documents before
            accepting a case.
          </p>
        </div>
      </div>
    </AppShell>
  );
}
