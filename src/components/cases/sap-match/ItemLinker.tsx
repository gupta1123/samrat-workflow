"use client";

import { searchSapItems } from "@/lib/sap-match-client";
import type { MatchCheck } from "@/lib/sap-match/types";
import { LinkSearch } from "./LinkSearch";

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
  return (
    <>
      <LinkSearch
        title={check.title}
        help={check.help}
        noun="item"
        suggestionsLabel="Suggested"
        suggestions={(check.itemSuggestions ?? []).map((item) => ({
          code: item.itemCode,
          name: item.name,
          note: item.why,
        }))}
        additionalSuggestionGroups={[
          {
            label:
              "Found in SAP Item Master · name match only · confirmation required",
            choices: (check.itemMasterSuggestions ?? []).map((item) => ({
              code: item.itemCode,
              name: item.name,
              note: item.why,
            })),
          },
        ]}
        placeholder="Search SAP items by name or code…"
        busy={busy}
        disabledReason={
          canLink
            ? undefined
            : "The SAP vendor must be found before an item can be linked."
        }
        search={async (query) =>
          (await searchSapItems(caseId, query)).map((item) => ({
            code: item.itemCode,
            name: item.name,
            note:
              item.inventory === true
                ? "stock item"
                : item.inventory === false
                  ? "non-stock item"
                  : undefined,
          }))
        }
        onLink={onLink}
      />
      {canLink && check.itemMasterSearchUnavailable ? (
        <p className="text-[11px] text-[#6b5d50]">
          Item Master suggestions could not be loaded. You can still search
          manually or review the supplier’s PO lines.
        </p>
      ) : null}
    </>
  );
}
