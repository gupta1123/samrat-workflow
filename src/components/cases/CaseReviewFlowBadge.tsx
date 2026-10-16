import type { ReviewFlow } from "@/lib/sap-match/review-flow";

const LABELS: Record<ReviewFlow, string> = {
  material_grpo: "Material · goods receipt",
  non_stock_po: "Non-material · PO line",
  service_po: "Service · PO line",
  mixed: "Mixed lines",
  already_recorded: "Already in SAP",
};

/** Says how the case is reviewed, and flags an invoice that reads as goods but is handled without stock. */
export function reviewFlowBadge(
  flow: string | null | undefined,
  supplyKind: string | null | undefined,
) {
  const label = flow ? LABELS[flow as ReviewFlow] : undefined;
  if (!label) return null;
  const warn =
    supplyKind === "goods" &&
    (flow === "non_stock_po" || flow === "service_po");
  return {
    label,
    warn,
    title: warn
      ? "The invoice reads as goods, but its items are not stock items in SAP, so it is reviewed against PO lines."
      : undefined,
  };
}

export function CaseReviewFlowBadge({
  flow,
  supplyKind,
}: {
  flow?: string | null;
  supplyKind?: string | null;
}) {
  const badge = reviewFlowBadge(flow, supplyKind);
  if (!badge) return null;
  return (
    <span
      title={badge.title}
      className={`hidden shrink-0 items-center rounded-lg border px-2.5 py-1 text-xs font-medium sm:inline-flex ${
        badge.warn
          ? "border-[#ecd29a] bg-[#fbf3de] text-[#7a5410]"
          : "border-[#ded8d0] bg-[#fbfaf8] text-[#5a5046]"
      }`}
    >
      {badge.label}
      {badge.warn ? " · invoice reads as goods" : ""}
    </span>
  );
}
