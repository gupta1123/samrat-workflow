"use client";

import { useState } from "react";
import { Link2, Loader2, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { searchSapItems, type SapItemChoice } from "@/lib/sap-match-client";
import type { MatchCheck } from "@/lib/sap-match/types";

// Links a vendor's own material code to one of your SAP items, once. The choice
// is remembered so the next invoice with the same material matches by itself.
export function ItemLinker({
  caseId,
  check,
  canLink,
  busy,
  onLink,
}: {
  caseId: string;
  check: MatchCheck;
  canLink: boolean;
  busy: boolean;
  onLink: (itemCode: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SapItemChoice[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    setSearching(true);
    setError(null);
    try {
      setResults(await searchSapItems(caseId, query));
    } catch (searchError) {
      setError(
        searchError instanceof Error ? searchError.message : "Search failed.",
      );
    } finally {
      setSearching(false);
    }
  }

  const suggestions = check.itemSuggestions ?? [];
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
      {!canLink ? (
        <div className="mt-2 text-[11px] text-[#b3261e]">
          The SAP vendor must be found before an item can be linked.
        </div>
      ) : (
        <>
          {suggestions.length ? (
            <div className="mt-3 space-y-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[#8a7f72]">
                Suggested
              </div>
              {suggestions.map((suggestion) => (
                <div
                  key={suggestion.itemCode}
                  className="flex items-center gap-2 rounded-md border border-[#e0d8cc] bg-white px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium text-[#111827]">
                      {suggestion.name}
                    </div>
                    <div className="text-[10px] text-[#8a7f72]">
                      <span className="font-mono">{suggestion.itemCode}</span> ·{" "}
                      {suggestion.why}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    className="h-7 px-2.5 text-[11px]"
                    disabled={busy}
                    onClick={() => onLink(suggestion.itemCode)}
                  >
                    <Link2 className="h-3 w-3" /> Select Item
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="mt-3 flex gap-2">
            <input
              className="h-8 min-w-0 flex-1 rounded-md border border-[#cfc4b8] bg-white px-2 text-[11px] outline-none focus:border-[#2d6a4f]"
              placeholder="Search Item Description or Item No."
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
            <ul className="mt-2 max-h-48 divide-y divide-[#f0ece4] overflow-y-auto rounded-md border border-[#e0d8cc] bg-white">
              {results.map((item) => (
                <li
                  key={item.itemCode}
                  className="flex items-center gap-2 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium text-[#111827]">
                      {item.name}
                    </div>
                    <div className="text-[10px] text-[#8a7f72]">
                      <span className="font-mono">{item.itemCode}</span>
                      {item.inventory === true
                        ? " · stock item"
                        : item.inventory === false
                          ? " · service"
                          : ""}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    className="h-7 px-2.5 text-[11px]"
                    disabled={busy}
                    onClick={() => onLink(item.itemCode)}
                  >
                    <Link2 className="h-3 w-3" /> Select Item
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}
