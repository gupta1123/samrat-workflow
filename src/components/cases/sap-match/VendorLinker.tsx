"use client";

import { searchSapVendors } from "@/lib/sap-match-client";
import type { MatchCheck } from "@/lib/sap-match/types";
import { LinkSearch } from "./LinkSearch";

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
  return (
    <LinkSearch
      title={check.title}
      help={check.help}
      noun="vendor"
      suggestionsLabel="Exact SAP matches · confirm one"
      suggestions={(check.vendorSuggestions ?? []).map((vendor) => ({
        code: vendor.cardCode,
        name: vendor.cardName,
        note: vendor.why,
      }))}
      placeholder="Search SAP vendors by name or code…"
      busy={busy}
      search={async (query) =>
        (await searchSapVendors(caseId, query)).map((vendor) => ({
          code: vendor.cardCode,
          name: vendor.cardName,
        }))
      }
      onLink={onLink}
    />
  );
}
