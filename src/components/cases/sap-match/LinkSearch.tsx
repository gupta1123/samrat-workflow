"use client";

import { useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";

import { Button } from "@/components/ui/button";

export type LinkChoice = { code: string; name: string; note?: string };

// Shared by the item and vendor linkers: suggestions first, then a search box that
// looks things up in SAP as you type and lists the matches right underneath.
export function LinkSearch({
  title,
  help,
  suggestionsLabel,
  suggestions,
  additionalSuggestionGroups = [],
  noun,
  placeholder,
  busy,
  disabledReason,
  search,
  onLink,
}: {
  title: string;
  help?: string;
  suggestionsLabel: string;
  suggestions: LinkChoice[];
  additionalSuggestionGroups?: Array<{ label: string; choices: LinkChoice[] }>;
  noun: "item" | "vendor";
  placeholder: string;
  busy: boolean;
  /** Shown instead of the search box when linking is not possible yet. */
  disabledReason?: string;
  search: (query: string) => Promise<LinkChoice[]>;
  onLink: (code: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LinkChoice[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < 2) {
      setResults([]);
      setError(null);
      setSearching(false);
      return;
    }
    let active = true;
    setSearching(true);
    const timer = setTimeout(() => {
      search(trimmed)
        .then((found) => {
          if (!active) return;
          setResults(found);
          setError(null);
        })
        .catch((searchError) => {
          if (active)
            setError(
              searchError instanceof Error
                ? searchError.message
                : "Search failed.",
            );
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // `search` is recreated by the parent on every render; only the text matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed]);

  const row = (choice: LinkChoice) => (
    <div
      key={choice.code}
      className="flex items-center gap-2 border-b border-[#f0ece4] px-3 py-2 last:border-0"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium text-[#111827]">
          {choice.name}
        </div>
        <div className="text-[10px] text-[#8a7f72]">
          <span className="font-mono">{choice.code}</span>
          {choice.note ? ` · ${choice.note}` : ""}
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2.5 text-[11px]"
        disabled={busy}
        onClick={() => onLink(choice.code)}
      >
        Select {noun}
      </Button>
    </div>
  );

  return (
    <section
      aria-label={title}
      className="rounded-lg border border-[#f3c6c0] bg-[#fdf6f5] px-3 py-2"
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#fbe7e5] text-[10px] font-bold text-[#b3261e]">
          ✕
        </span>
        <b className="text-[12px] text-[#111827]">{title}</b>
      </div>
      {help ? (
        <p className="mt-1 text-[11px] leading-4 text-[#6b5d50]">{help}</p>
      ) : null}
      {disabledReason ? (
        <p className="mt-2 text-[11px] text-[#b3261e]">{disabledReason}</p>
      ) : (
        <>
          {suggestions.length ? (
            <div className="mt-2 overflow-hidden rounded-md border border-[#e0d8cc] bg-white">
              <div className="border-b border-[#f0ece4] bg-[#faf8f4] px-3 py-1 text-[10px] text-[#6b5d50]">
                {suggestionsLabel}
              </div>
              {suggestions.map(row)}
            </div>
          ) : null}
          {additionalSuggestionGroups
            .filter((group) => group.choices.length)
            .map((group) => (
              <div
                key={group.label}
                className="mt-2 overflow-hidden rounded-md border border-[#e0d8cc] bg-white"
              >
                <div className="border-b border-[#f0ece4] bg-[#faf8f4] px-3 py-1 text-[10px] text-[#6b5d50]">
                  {group.label}
                </div>
                {group.choices.map(row)}
              </div>
            ))}
          <label className="mt-2 flex h-8 max-w-md items-center gap-2 rounded-md border border-[#e0d8cc] bg-white px-2.5 text-[#8a7f72] focus-within:border-[#a89c8e] focus-within:ring-2 focus-within:ring-[#6b4a33]/10">
            {searching ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5 shrink-0" />
            )}
            <input
              aria-label={placeholder}
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              value={query}
              className="min-w-0 flex-1 bg-transparent text-[11px] text-[#111827] outline-none placeholder:text-[#a89c8e]"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {error ? (
            <p className="mt-1.5 text-[11px] text-[#b3261e]">{error}</p>
          ) : null}
          {trimmed.length >= 2 && !searching && !error ? (
            results.length ? (
              <div className="mt-1.5 max-h-56 max-w-md overflow-y-auto rounded-md border border-[#e0d8cc] bg-white">
                {results.map(row)}
              </div>
            ) : (
              <p className="mt-1.5 text-[11px] text-[#8a7f72]">
                No {noun} found for “{trimmed}”.
              </p>
            )
          ) : null}
        </>
      )}
    </section>
  );
}
