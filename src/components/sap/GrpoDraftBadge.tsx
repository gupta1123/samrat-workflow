import React from "react";
import type { GrpoSapDraftState } from "@/lib/grpo-import";

export function GrpoDraftBadge({ draft }: { draft?: GrpoSapDraftState }) {
  const status = draft?.status ?? "unavailable";
  const number = draft?.docNum ?? draft?.docEntry;
  const label =
    status === "created"
      ? `Draft created${number ? ` · ${number}` : ""}`
      : status === "not_created"
        ? "Not drafted"
        : status === "posted"
          ? "Invoice posted"
          : "Draft status unavailable";
  const color =
    status === "created"
      ? "bg-emerald-50 text-emerald-800"
      : status === "not_created"
        ? "bg-amber-50 text-amber-800"
        : status === "posted"
          ? "bg-sky-50 text-sky-800"
          : "bg-stone-100 text-stone-600";
  return (
    <span
      className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${color}`}
      title={
        status === "created"
          ? `Saved SAP draft${draft?.docEntry ? ` · entry ${draft.docEntry}` : ""}`
          : status === "unavailable"
            ? "Refresh to check the saved SAP draft status."
            : undefined
      }
    >
      {label}
    </span>
  );
}
