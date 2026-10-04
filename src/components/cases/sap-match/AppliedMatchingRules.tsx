import Link from "next/link";
import type { MatchRules } from "@/lib/sap-match/types";

const freightLabels = {
  expense: "Freight charge on invoice",
  item: "Included in material cost",
  separate: "Separate freight PO",
};

export function AppliedMatchingRules({ rules }: { rules: MatchRules }) {
  return (
    <section className="rounded-lg border border-[#e0d8cc] bg-white px-3 py-2.5 text-[10px] text-[#6b6258]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold text-[#3d3530]">
          Rules applied to this check
        </h3>
        <Link
          href="/settings#sap-matching"
          className="text-[11px] text-[#6b4a33] underline"
        >
          Manage in Settings
        </Link>
      </div>
      <p className="mt-1">
        Quantity tolerance: {rules.qtyTolerancePct}% · Unit price tolerance: ±
        {rules.rateTolerancePct}% · GRPO matching window:{" "}
        {rules.receiptWindowDays} days
      </p>
      <p className="mt-1">
        {freightLabels[rules.freightPolicy]} · Posting Date:{" "}
        {rules.postingDate === "today"
          ? "Date of check"
          : "Supplier invoice date"}{" "}
        ·{" "}
        {rules.branches.length
          ? `${rules.branches.length} branch ${rules.branches.length === 1 ? "mapping" : "mappings"}`
          : "No branch mappings"}
      </p>
    </section>
  );
}
