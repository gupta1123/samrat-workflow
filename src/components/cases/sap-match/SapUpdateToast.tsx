"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, TriangleAlert } from "lucide-react";

import type { MatchUpdate } from "./MatchUpdateContext";

const DONE_VISIBLE_MS = 2800;

/**
 * Always-visible progress for background SAP checks. The inline notice sits
 * next to the line that changed and can be scrolled out of view, so the same
 * state is repeated here, pinned to the viewport.
 */
export function SapUpdateToast({
  update,
  onRetry,
}: {
  update: MatchUpdate | null;
  onRetry: () => void;
}) {
  const [done, setDone] = useState(false);
  const previous = useRef<MatchUpdate | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = update;
    if (update || !before || before.phase === "failed") {
      setDone(false);
      return;
    }
    setDone(true);
    const timer = window.setTimeout(() => setDone(false), DONE_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [update]);

  if (!update && !done) return null;

  const failed = update?.phase === "failed";
  const title = done
    ? "SAP check complete"
    : failed
      ? "Could not verify this change"
      : update?.phase === "saving"
        ? "Saving your selection…"
        : "Checking it against SAP…";
  const detail = done
    ? "The comparison and totals are up to date."
    : failed
      ? "The last verified comparison is still shown."
      : update?.phase === "saving"
        ? "Keep this page open."
        : "Totals update when this finishes.";

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[70] flex justify-center px-4">
      <div
        role={failed ? "alert" : "status"}
        aria-live={failed ? "assertive" : "polite"}
        className={`pointer-events-auto flex max-w-md items-center gap-3 rounded-xl border px-4 py-3 text-[12px] shadow-[0_8px_28px_rgba(31,30,28,0.18)] ${failed ? "border-[#f3c6c0] bg-[#fdf6f5] text-[#7a1f16]" : done ? "border-[#c4dfcf] bg-[#f1f8f4] text-[#24583e]" : "border-[#e0d8cc] bg-white text-[#3d3530]"}`}
      >
        {failed ? (
          <TriangleAlert className="h-4 w-4 shrink-0" />
        ) : done ? (
          <Check className="h-4 w-4 shrink-0" strokeWidth={3} />
        ) : (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        )}
        <span className="min-w-0">
          <b className="block font-semibold">{title}</b>
          <span className="block opacity-80">{detail}</span>
        </span>
        {failed ? (
          <button
            type="button"
            onClick={onRetry}
            className="ml-2 shrink-0 rounded-md border border-current px-2.5 py-1 font-semibold"
          >
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}
