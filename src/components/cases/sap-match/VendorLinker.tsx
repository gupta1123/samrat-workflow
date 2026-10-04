"use client";

import { useState } from "react";
import { Link2, Loader2, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { searchSapVendors, type SapVendorChoice } from "@/lib/sap-match-client";
import type { MatchCheck } from "@/lib/sap-match/types";

// Records an explicit reviewer-confirmed SAP vendor choice for this case. It is
// reusable only with the same exact GSTIN and vendor material identity.
export function VendorLinker({
  caseId,
  check,
  busy,
  onLink,
}: {
  caseId: string;
  check: MatchCheck;
  busy: boolean;
  onLink: (cardCode: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SapVendorChoice[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setSearching(true);
    setError(null);
    try {
      const found = await searchSapVendors(caseId, query);
      setResults(found);
      if (!found.length) setError("No SAP supplier matches that search.");
    } catch (searchError) {
      setError(
        searchError instanceof Error ? searchError.message : "Search failed.",
      );
    } finally {
      setSearching(false);
    }
  }

  const suggestions = check.vendorSuggestions ?? [];
  const row = (
    vendor: { cardCode: string; cardName: string },
    note?: string,
  ) => (
    <div
      key={vendor.cardCode}
      className="flex items-center gap-2 rounded-md border border-[#e0d8cc] bg-white px-3 py-2"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium text-[#111827]">
          {vendor.cardName}
        </div>
        <div className="text-[10px] text-[#8a7f72]">
          <span className="font-mono">{vendor.cardCode}</span>
          {note ? ` · ${note}` : ""}
        </div>
      </div>
      <Button
        size="sm"
        className="h-7 px-2.5 text-[11px]"
        disabled={busy}
        onClick={() => onLink(vendor.cardCode)}
      >
        <Link2 className="h-3 w-3" /> Select Vendor
      </Button>
    </div>
  );

  return (
    <div className="rounded-lg border border-[#f3c6c0] bg-[#fdf3f1] px-4 py-3">
      <div className="text-[12px] font-semibold text-[#111827]">
        {check.title}
      </div>
      {check.help ? (
        <div className="mt-1 text-[11px] leading-4 text-[#6b5d50]">
          {check.help}
        </div>
      ) : null}
      {suggestions.length ? (
        <div className="mt-3 space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[#8a7f72]">
            Exact SAP matches — confirmation required
          </div>
          {suggestions.map((vendor) =>
            row(vendor, "why" in vendor ? String(vendor.why) : undefined),
          )}
        </div>
      ) : null}
      <div className="mt-3 flex gap-2">
        <input
          className="h-8 min-w-0 flex-1 rounded-md border border-[#cfc4b8] bg-white px-2 text-[11px] outline-none focus:border-[#2d6a4f]"
          placeholder="Search Vendor Name or Vendor Code"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && query.trim().length >= 2)
              void search();
          }}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-8 px-3 text-[11px]"
          disabled={searching || query.trim().length < 2}
          onClick={() => void search()}
        >
          {searching ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Search className="h-3 w-3" />
          )}{" "}
          Search
        </Button>
      </div>
      {error ? (
        <div className="mt-2 text-[11px] text-[#b3261e]">{error}</div>
      ) : null}
      {results.length ? (
        <div className="mt-2 max-h-48 space-y-1.5 overflow-y-auto">
          {results.map((vendor) => row(vendor))}
        </div>
      ) : null}
    </div>
  );
}
