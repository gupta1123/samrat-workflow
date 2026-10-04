"use client";

import { Fragment, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import {
  BUSINESS_PARTNER_TYPES,
  businessPartnerTypeLabel,
  type BusinessPartnerPage,
  type BusinessPartnerType,
} from "@/lib/sap-business-partners";
import { Button } from "@/components/ui/button";

const yesNo = (value: boolean | null) =>
  value === null ? "Unknown" : value ? "Yes" : "No";

export function BusinessPartnersTab() {
  const [search, setSearch] = useState("");
  const [type, setType] = useState<BusinessPartnerType>("cSupplier");
  const [criteria, setCriteria] = useState({
    search: "",
    type: "cSupplier" as BusinessPartnerType,
  });
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<BusinessPartnerPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const cursor = cursors[page];

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setData(null);
    setError(null);
    setExpanded(null);
    const params = new URLSearchParams({
      q: criteria.search,
      type: criteria.type,
      limit: "50",
    });
    if (cursor) params.set("after", cursor);
    void (async () => {
      try {
        const response = await apiFetch(
          `/api/sap-inspector/business-partners?${params}`,
          { cache: "no-store", signal: controller.signal },
        );
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error || "Could not read Business Partners.");
        if (!Array.isArray(body.records))
          throw new Error(
            "SAP returned an invalid Business Partners response.",
          );
        if (active) setData(body as BusinessPartnerPage);
      } catch (failure) {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not read Business Partners.",
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

  function reload() {
    setPage(0);
    setCursors([null]);
    setRefresh((value) => value + 1);
  }
  const button = "h-8 border-[#ddd4c8] bg-white px-3 text-[11px]";

  return (
    <section className="mt-4 text-[11px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-[12px] font-semibold">Business Partners</h2>
          <p className="mt-1 text-[11px] text-[#81766b]">
            Supplier, customer and lead master data · SAP Test · Read only
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={loading}
          onClick={reload}
          className={button}
        >
          <RefreshCw className="h-3 w-3" />
          Refresh Business Partners
        </Button>
      </div>
      <p className="mt-2 text-[10px] text-[#81766b]">
        BP Code is SAP&apos;s CardCode. GSTINs are read from the partner&apos;s
        SAP addresses. Next loads more records from SAP.
      </p>
      <form
        className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-[#e2dacf] bg-white p-3"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(0);
          setCursors([null]);
          setCriteria({ search: search.trim(), type });
        }}
      >
        <label className="flex h-8 min-w-0 flex-[1_1_240px] items-center gap-2 rounded-md border border-[#ddd4c8] px-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-[#8b8177]" />
          <input
            aria-label="Search Business Partners"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={100}
            placeholder="Search BP code or name, e.g. TSPL001"
            className="min-w-0 flex-1 bg-transparent text-[11px] outline-none"
          />
        </label>
        <select
          aria-label="Business Partner type"
          value={type}
          onChange={(event) =>
            setType(event.target.value as BusinessPartnerType)
          }
          className="h-8 rounded-md border border-[#ddd4c8] bg-white px-2 text-[11px]"
        >
          {BUSINESS_PARTNER_TYPES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <Button type="submit" variant="outline" className={button}>
          Search SAP
        </Button>
      </form>
      {loading ? (
        <p
          role="status"
          className="mt-6 flex items-center gap-2 text-[#81766b]"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Reading Business Partners from SAP…
        </p>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-800"
        >
          <p>{error}</p>
          <Button
            type="button"
            variant="outline"
            className={`${button} mt-2`}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Retry Business Partners
          </Button>
        </div>
      ) : null}
      {data ? (
        <div className="mt-3 overflow-hidden rounded-lg border border-[#e1d9ce] bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-left text-[11px]">
              <thead className="bg-[#f3efe9] text-[10px] text-[#766c61]">
                <tr>
                  {[
                    "BP Code",
                    "Business Partner",
                    "Type",
                    "GSTIN",
                    "Active flag",
                    "Frozen flag",
                    "Currency",
                  ].map((label) => (
                    <th key={label} className="px-3 py-2 font-semibold">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.records.map((record) => (
                  <Fragment key={record.code}>
                    <tr className="border-t border-[#ece6de] align-top">
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          aria-label={`Show addresses for ${record.code}`}
                          aria-expanded={expanded === record.code}
                          onClick={() =>
                            setExpanded(
                              expanded === record.code ? null : record.code,
                            )
                          }
                          className="flex items-center gap-1.5 font-mono font-semibold text-[#6b3d20]"
                        >
                          {expanded === record.code ? (
                            <ChevronDown className="h-3 w-3" />
                          ) : (
                            <ChevronRight className="h-3 w-3" />
                          )}
                          {record.code}
                        </button>
                      </td>
                      <td className="max-w-[320px] break-words px-3 py-2">
                        {record.name ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        {businessPartnerTypeLabel(record.type)}
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {record.gstins.length
                          ? record.gstins.map((gstin) => (
                              <div key={gstin}>{gstin}</div>
                            ))
                          : "—"}
                      </td>
                      <td className="px-3 py-2">{yesNo(record.valid)}</td>
                      <td className="px-3 py-2">{yesNo(record.frozen)}</td>
                      <td className="px-3 py-2 font-mono">
                        {record.currency ?? "—"}
                      </td>
                    </tr>
                    {expanded === record.code ? (
                      <tr>
                        <td
                          colSpan={7}
                          className="border-t border-[#ece6de] bg-[#fbfaf8] px-4 py-3"
                        >
                          <h3 className="text-[11px] font-semibold">
                            SAP addresses for {record.code}
                          </h3>
                          {record.addresses.length ? (
                            <ul className="mt-2 space-y-2">
                              {record.addresses.map((address, index) => (
                                <li key={index} className="text-[10px]">
                                  <span className="font-semibold">
                                    {address.name ?? "Unnamed address"}
                                  </span>{" "}
                                  ·{" "}
                                  {address.type === "bo_BillTo"
                                    ? "Bill to"
                                    : address.type === "bo_ShipTo"
                                      ? "Ship to"
                                      : (address.type ??
                                        "Type not recorded")}{" "}
                                  ·{" "}
                                  {[
                                    address.city,
                                    address.state,
                                    address.country,
                                  ]
                                    .filter(Boolean)
                                    .join(", ") || "Location not recorded"}
                                  <div className="mt-0.5 font-mono">
                                    GSTIN: {address.gstin ?? "Not recorded"}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-1 text-[#81766b]">
                              No addresses returned by SAP.
                            </p>
                          )}
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
              No Business Partners found. Try another BP code, name or type.
            </p>
          ) : null}
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[#e7e0d7] bg-[#fbfaf8] px-3 py-2 text-[10px] text-[#776d63]">
            <span>
              Page {page + 1} · {data.records.length} records
              {data.nextCursor
                ? " · More records available"
                : " · End of results"}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className={`${button} h-7`}
                disabled={page === 0}
                onClick={() => setPage((value) => value - 1)}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                className={`${button} h-7`}
                disabled={!data.nextCursor}
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
