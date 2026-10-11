"use client";

import { useId, useMemo, useState } from "react";
import { Search } from "lucide-react";

export type SearchSelectOption = { value: string; label: string };

const SHOWN = 6;

// Pick one option by typing. The list sits under the field (not in a popup), shows
// the first few matches, and collapses to the chosen value with a Change link.
export function SearchSelect({
  options,
  value,
  onChange,
  placeholder = "Search…",
  ariaLabel,
  disabled = false,
}: {
  options: SearchSelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [editing, setEditing] = useState(false);
  const listId = useId();
  const chosen = options.find((option) => option.value === value);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter(
      (option) =>
        !q ||
        option.label.toLowerCase().includes(q) ||
        option.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  if (chosen && !editing)
    return (
      <div className="flex min-h-8 items-center justify-between gap-2 rounded-md border border-[#e0d8cc] bg-white px-3 text-[11px] text-[#111827]">
        <span className="min-w-0 truncate">
          {chosen.label}
          {chosen.label !== chosen.value ? (
            <em className="ml-1.5 not-italic text-[#8a7f72]">{chosen.value}</em>
          ) : null}
        </span>
        {!disabled ? (
          <button
            type="button"
            className="shrink-0 text-[11px] font-medium text-[#6b4a33] underline"
            onClick={() => {
              setQuery("");
              setEditing(true);
            }}
          >
            Change
          </button>
        ) : null}
      </div>
    );

  return (
    <div>
      <label className="flex h-8 items-center gap-2 rounded-md border border-[#e0d8cc] bg-white px-2.5 text-[#8a7f72] focus-within:border-[#a89c8e] focus-within:ring-2 focus-within:ring-[#6b4a33]/10">
        <Search className="h-3.5 w-3.5 shrink-0" />
        <input
          aria-label={ariaLabel}
          aria-controls={listId}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          placeholder={placeholder}
          value={query}
          className="min-w-0 flex-1 bg-transparent text-[11px] text-[#111827] outline-none placeholder:text-[#a89c8e]"
          onFocus={() => setFocused(true)}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && matches[0]) {
              event.preventDefault();
              onChange(matches[0].value);
              setEditing(false);
            }
          }}
        />
      </label>
      {focused || query ? (
        <div
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="mt-1.5 overflow-hidden rounded-md border border-[#e0d8cc] bg-white"
        >
          {matches.length ? (
            <>
              {matches.slice(0, SHOWN).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  className="flex w-full items-baseline gap-2 border-b border-[#f0ece4] px-3 py-1.5 text-left text-[11px] last:border-0 hover:bg-[#faf8f4]"
                  onClick={() => {
                    onChange(option.value);
                    setEditing(false);
                    setQuery("");
                  }}
                >
                  <span className="text-[#111827]">{option.label}</span>
                  {option.label !== option.value ? (
                    <span className="text-[10px] text-[#8a7f72]">
                      {option.value}
                    </span>
                  ) : null}
                </button>
              ))}
              {matches.length > SHOWN ? (
                <div className="bg-[#faf8f4] px-3 py-1.5 text-[10px] text-[#8a7f72]">
                  {matches.length - SHOWN} more. Keep typing to narrow down.
                </div>
              ) : null}
            </>
          ) : (
            <div className="px-3 py-2 text-[11px] text-[#8a7f72]">
              No match for “{query.trim()}”.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
