"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import type { SapInspectorRecord } from "@/lib/sap-inspector";
import type {
  GrpoInspectorPage,
  GrpoInspectorQuery,
} from "@/lib/sap-grpo-inspector";

export function GrpoInspectorTab({
  renderDetails,
}: {
  renderDetails: (record: SapInspectorRecord) => ReactNode;
}) {
  const [search, setSearch] = useState("");
  const [supplier, setSupplier] = useState("");
  const [status, setStatus] = useState<GrpoInspectorQuery["status"]>("open");
  const [criteria, setCriteria] = useState({
    search: "",
    supplier: "",
    status: "open" as GrpoInspectorQuery["status"],
  });
  const [cursors, setCursors] = useState<Array<number | null>>([null]);
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<GrpoInspectorPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const cursor = cursors[page];
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setData(null);
    setError(null);
    setLoading(true);
    setExpanded(null);
    const params = new URLSearchParams({
      q: criteria.search,
      supplier: criteria.supplier,
      status: criteria.status,
      limit: "25",
    });
    if (cursor !== null) params.set("before", String(cursor));
    void (async () => {
      try {
        const response = await apiFetch(`/api/sap-inspector/grpos?${params}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error || "Could not read GRPOs.");
        if (!Array.isArray(body.records))
          throw new Error("SAP returned an invalid GRPO response.");
        if (active) setData(body);
      } catch (failure) {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not read GRPOs.",
          );
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [criteria, cursor, refresh]);
  const button = "h-8 border-[#ddd4c8] bg-white px-3 text-[11px]";
  return (
    <section className="mt-4 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-[12px] font-semibold">Goods Receipt PO (GRPO)</h2>
          <p className="mt-1 text-[#81766b]">
            SAP Test · Read only · Open GRPOs shown by default
          </p>
        </div>
        <Button
          variant="outline"
          className={button}
          disabled={loading}
          onClick={() => {
            setPage(0);
            setCursors([null]);
            setRefresh((value) => value + 1);
          }}
        >
          <RefreshCw className="h-3 w-3" />
          Refresh GRPOs
        </Button>
      </div>
      <form
        className="mt-3 flex flex-wrap gap-2 rounded-lg border border-[#e2dacf] bg-white p-3"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(0);
          setCursors([null]);
          setCriteria({
            search: search.trim(),
            supplier: supplier.trim(),
            status,
          });
        }}
      >
        <input
          aria-label="Search SAP GRPOs"
          placeholder="GRPO / entry no., supplier name or header reference"
          maxLength={100}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-8 min-w-0 flex-[1_1_260px] rounded-md border border-[#ddd4c8] px-2 text-[11px]"
        />
        <input
          aria-label="Supplier BP code"
          placeholder="Supplier BP code, e.g. TSPL001"
          maxLength={100}
          value={supplier}
          onChange={(event) => setSupplier(event.target.value)}
          className="h-8 min-w-0 flex-[0_1_210px] rounded-md border border-[#ddd4c8] px-2 text-[11px]"
        />
        <select
          aria-label="GRPO status"
          value={status}
          onChange={(event) =>
            setStatus(event.target.value as GrpoInspectorQuery["status"])
          }
          className="h-8 rounded-md border border-[#ddd4c8] bg-white px-2 text-[11px]"
        >
          <option value="open">Open, not cancelled</option>
          <option value="closed">Closed, not cancelled</option>
          <option value="all">All statuses</option>
        </select>
        <Button type="submit" variant="outline" className={button}>
          Search SAP
        </Button>
        <p className="w-full text-[10px] text-[#81766b]">
          Search runs in SAP across GRPO numbers, supplier names and header
          invoice, e-way bill, LR and vehicle references. Expand a row for item
          lines and line-specific references. Next loads older results from SAP.
        </p>
      </form>
      {loading ? (
        <p
          role="status"
          className="mt-6 flex items-center gap-2 text-[#81766b]"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Reading GRPOs and linked POs from SAP…
        </p>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-800"
        >
          <p>{error}</p>
          <Button
            variant="outline"
            className={`${button} mt-2`}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Retry GRPOs
          </Button>
        </div>
      ) : null}
      {data ? (
        <div className="mt-3 overflow-hidden rounded-lg border border-[#e1d9ce] bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-left text-[11px]">
              <thead className="bg-[#f3efe9] text-[10px] text-[#766c61]">
                <tr>
                  {[
                    "GRPO No.",
                    "Supplier / BP Code",
                    "Date",
                    "Vendor Invoice No.",
                    "Linked PO No.",
                    "Status",
                    "Lines",
                  ].map((label) => (
                    <th key={label} className="px-3 py-2 font-semibold">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.records.map((record) => (
                  <Fragment key={record.id}>
                    <tr className="border-t border-[#ece6de] align-top">
                      <td className="px-3 py-2">
                        <button
                          aria-label={`Show GRPO ${record.docNumber} details`}
                          aria-expanded={expanded === record.id}
                          onClick={() =>
                            setExpanded(
                              expanded === record.id ? null : record.id,
                            )
                          }
                          className="flex items-center gap-1 font-mono font-semibold text-[#6b3d20]"
                        >
                          {expanded === record.id ? (
                            <ChevronDown className="h-3 w-3" />
                          ) : (
                            <ChevronRight className="h-3 w-3" />
                          )}
                          {record.docNumber ?? "—"}
                        </button>
                        <div className="mt-0.5 text-[9px] text-[#91877c]">
                          Entry {record.docEntry}
                        </div>
                      </td>
                      <td className="max-w-[240px] break-words px-3 py-2">
                        {record.vendorName ?? "—"}
                        <div className="mt-0.5 font-mono text-[10px] text-[#91877c]">
                          {record.vendorCode}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {record.date?.slice(0, 10) ?? "—"}
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {[
                          ...new Set(
                            record.lines
                              .map((line) => line.matchReferences?.invoice)
                              .filter(Boolean),
                          ),
                        ].join(" · ") || "—"}
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {[
                          ...new Set(
                            record.lines
                              .map((line) => line.linkedPoNumber)
                              .filter(Boolean),
                          ),
                        ].join(" · ") || "—"}
                      </td>
                      <td className="px-3 py-2">{record.status}</td>
                      <td className="px-3 py-2">{record.lines.length}</td>
                    </tr>
                    {expanded === record.id ? (
                      <tr>
                        <td colSpan={7} className="p-0">
                          {renderDetails(record)}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {!data.records.length ? (
            <p className="px-4 py-8 text-center text-[#81766b]">
              No GRPOs found. Change the supplier, search or status.
            </p>
          ) : null}
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[#e7e0d7] bg-[#fbfaf8] px-3 py-2 text-[10px] text-[#776d63]">
            <span>
              Page {page + 1} · {data.records.length} records
              {data.nextCursor !== null
                ? " · More records available"
                : " · End of results"}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className={`${button} h-7`}
                disabled={page === 0}
                onClick={() => setPage((value) => value - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                className={`${button} h-7`}
                disabled={data.nextCursor === null}
                onClick={() => {
                  setCursors((current) => [
                    ...current.slice(0, page + 1),
                    data.nextCursor,
                  ]);
                  setPage((value) => value + 1);
                }}
              >
                Next
              </Button>
            </div>
          </footer>
        </div>
      ) : null}
    </section>
  );
}
