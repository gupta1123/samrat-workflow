"use client";

import { createContext, useContext } from "react";
import { Loader2 } from "lucide-react";
import type { SapMatchAction } from "@/lib/sap-match-client";

export type MatchUpdate = {
  action: SapMatchAction | null;
  lineIndex: number | null;
  phase: "saving" | "validating" | "failed";
};
export const MatchUpdateContext = createContext<MatchUpdate | null>(null);

export function useMatchUpdate(lineIndex: number | null) {
  const update = useContext(MatchUpdateContext);
  return update?.lineIndex === lineIndex ? update : null;
}

export function MatchUpdateNotice({ lineIndex }: { lineIndex: number | null }) {
  const update = useMatchUpdate(lineIndex);
  if (!update) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 text-[11px] text-[#6b5d50]"
    >
      {update.phase !== "failed" ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      ) : null}
      {update.phase === "saving"
        ? "Saving selection…"
        : update.phase === "failed"
          ? "This change could not be verified. The last verified comparison is still shown."
          : update.action
            ? "Selection saved. Checking it against SAP; totals shown are the last verified values."
            : "Checking SAP; the last verified comparison stays visible."}
    </div>
  );
}
