"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api-client";
import type { ItemsPage } from "@/lib/sap-items-inspector";
import { Button } from "@/components/ui/button";

const flag = (value: boolean | null) =>
  value === null ? "Unknown" : value ? "Yes" : "No";

export function ItemsInspectorTab() {
  const [search, setSearch] = useState("");
  const [criteria, setCriteria] = useState("");
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [page, setPage] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<ItemsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const cursor = cursors[page];
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setData(null);
    setError(null);
    const params = new URLSearchParams({ q: criteria, limit: "50" });
    if (cursor) params.set("after", cursor);
    void (async () => {
      try {
        const response = await apiFetch(`/api/sap-inspector/items?${params}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error || "Could not read SAP items.");
        if (!Array.isArray(body.records))
          throw new Error("Invalid SAP items response.");
        if (active) setData(body as ItemsPage);
      } catch (failure) {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not read SAP items.",
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

  return (
    <section className="mt-4 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">Items — SAP Item Master</h2>
          <p className="mt-1 text-[#81766b]">
            All items, including inactive and frozen items · SAP Test · Read
            only
          </p>
        </div>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => {
            setPage(0);
            setCursors([null]);
            setRefresh((value) => value + 1);
          }}
        >
          Refresh items
        </Button>
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(0);
          setCursors([null]);
          setCriteria(search.trim());
          setRefresh((value) => value + 1);
        }}
      >
        <input
          aria-label="Search SAP items"
          placeholder="Search item code or name"
          value={search}
          maxLength={100}
          onChange={(event) => setSearch(event.target.value)}
          className="min-w-0 flex-1 rounded-md border border-[#ddd4c8] bg-white px-3 py-2"
        />
        <Button variant="outline" type="submit">
          Search SAP
        </Button>
        <Button
          variant="outline"
          type="button"
          onClick={() => {
            setSearch("");
            setCriteria("");
            setPage(0);
            setCursors([null]);
            setRefresh((value) => value + 1);
          }}
        >
          Show all
        </Button>
      </form>
      <p className="mt-2 text-[11px] text-[#81766b]">
        Search checks the full SAP Item Master. Next loads the next 50 items;
        the list is not limited to items from matching cases.
      </p>
      {loading ? (
        <p role="status" className="py-8 text-[#81766b]">
          Reading items from SAP…
        </p>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="mt-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-rose-800"
        >
          {error}
          <Button
            variant="outline"
            className="ml-3"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {data ? (
        <div className="mt-3 overflow-hidden rounded-lg border border-[#e1d9ce] bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-left">
              <thead className="bg-[#f3efe9] text-[#766c61]">
                <tr>
                  {[
                    "Item code",
                    "Item name",
                    "Stock item",
                    "Purchase item",
                    "Sales item",
                    "Active flag",
                    "Frozen flag",
                  ].map((label) => (
                    <th key={label} scope="col" className="px-3 py-2">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.records.map((item) => (
                  <tr key={item.code} className="border-t border-[#ece6de]">
                    <td className="px-3 py-2 font-mono">{item.code}</td>
                    <td className="px-3 py-2">{item.name ?? "—"}</td>
                    {[
                      item.inventory,
                      item.purchase,
                      item.sales,
                      item.valid,
                      item.frozen,
                    ].map((value, index) => (
                      <td key={index} className="px-3 py-2">
                        {flag(value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.records.length ? (
            <p className="p-8 text-center">
              No items found. Try another code or name.
            </p>
          ) : null}
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
            <span>
              Page {page + 1} · {data.records.length} items ·{" "}
              {data.nextCursor ? "More items available" : "End of results"}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={page === 0}
                onClick={() => setPage((value) => value - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
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
          <p className="px-3 pb-2 text-[10px] text-[#81766b]">
            Read from SAP Test at{" "}
            {new Date(data.fetchedAt).toLocaleString("en-IN")}
          </p>
        </div>
      ) : null}
    </section>
  );
}
