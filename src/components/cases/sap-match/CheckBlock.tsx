"use client";

import { useId, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CheckOption, MatchCheck } from "@/lib/sap-match/types";
import type { PriceReviewDetails } from "@/lib/sap-match/price-review";
import { PriceReviewBlock } from "./PriceReviewBlock";

// One decision for the reviewer: what is wrong, and the buttons that settle it.
// Compact on purpose: a single row of actions, one short paragraph of context.

const BOX = {
  block: "border-[#f3c6c0] bg-[#fdf6f5]",
  confirm: "border-[#f0d7a6] bg-[#fdf7ea]",
  ack: "border-[#f0d7a6] bg-[#fdf7ea]",
  wait: "border-[#dcd5cb] bg-[#f6f3ee]",
  pass: "border-[#c4dfcf] bg-[#f1f8f4]",
  unchecked: "border-[#dcd5cb] bg-[#f6f3ee]",
} as const;

const ICON = {
  block: { mark: "✕", cls: "bg-[#fbe7e5] text-[#b3261e]" },
  wait: { mark: "…", cls: "bg-[#ece6dc] text-[#5c5650]" },
  other: { mark: "!", cls: "bg-[#fdf1dc] text-[#8a5207]" },
} as const;

const MIN_REASON = 5;

export function ReasonForm({
  label,
  placeholder,
  busy,
  onConfirm,
  onCancel,
  confirmLabel = "Confirm",
}: {
  label: string;
  placeholder?: string;
  busy: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  confirmLabel?: string;
}) {
  const [reason, setReason] = useState("");
  const id = useId();
  return (
    <div className="mt-2 border-t border-black/5 pt-2">
      <label htmlFor={id} className="text-[10px] font-medium text-[#3d3530]">
        {label}
      </label>
      <textarea
        id={id}
        autoFocus
        rows={2}
        maxLength={500}
        value={reason}
        disabled={busy}
        placeholder={placeholder}
        className="mt-1 block w-full rounded-md border border-[#cfc4b8] bg-white px-2 py-1.5 text-[11px] text-[#111827] outline-none focus:border-[#2d6a4f] focus:ring-1 focus:ring-[#2d6a4f]"
        onChange={(event) => setReason(event.target.value)}
      />
      <p className="mt-1 text-[10px] text-[#6b5d50]">
        At least 5 characters · saved in the audit trail
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="h-7 px-2.5 text-[11px]"
          disabled={busy || reason.trim().length < MIN_REASON}
          onClick={() => onConfirm(reason.trim())}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {confirmLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2.5 text-[11px]"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function CheckBlock({
  check,
  locked,
  busy,
  onChoose,
  onUndo,
  priceReview,
}: {
  check: MatchCheck;
  locked: boolean;
  busy: boolean;
  onChoose: (choice: string, reason: string) => void;
  onUndo: () => void;
  priceReview?: PriceReviewDetails;
}) {
  const [picked, setPicked] = useState<CheckOption | null>(null);
  const answered = check.decision
    ? check.options?.find((option) => option.choice === check.decision!.choice)
    : undefined;

  // Already answered and no longer stopping the invoice.
  if (check.decision && !check.open) {
    const ended = check.decision.effect !== "resolve";
    return (
      <div
        role="status"
        className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-[11px] ${ended ? "border-[#dcd5cb] bg-[#f4f0e8] text-[#3d3530]" : "border-[#c4dfcf] bg-[#f1f8f4] text-[#1b4332]"}`}
      >
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${ended ? "bg-[#e6dfd3] text-[#5c5650]" : "bg-[#e3f1e8] text-[#2c6a4f]"}`}
        >
          {ended ? "–" : <Check className="h-2.5 w-2.5" strokeWidth={3} />}
        </span>
        <span className="font-medium">
          {answered?.title ?? "Confirmed by reviewer"}
        </span>
        {check.decision.reason ? (
          <span className="opacity-80">· “{check.decision.reason}”</span>
        ) : null}
        {!locked ? (
          <button
            type="button"
            className="ml-auto text-[11px] font-medium underline"
            disabled={busy}
            onClick={onUndo}
          >
            Change
          </button>
        ) : null}
      </div>
    );
  }
  if (!check.open) return null;
  if (
    priceReview &&
    !check.decision &&
    check.sev === "confirm" &&
    check.options?.some(
      (option) => option.needsReason && option.effect === "resolve",
    )
  ) {
    return (
      <PriceReviewBlock
        check={check}
        details={priceReview}
        locked={locked}
        busy={busy}
        onChoose={onChoose}
      />
    );
  }

  const icon =
    check.sev === "block"
      ? ICON.block
      : check.sev === "wait"
        ? ICON.wait
        : ICON.other;
  // Lines every option shares read as one note instead of repeating per button.
  const notes = [
    ...new Set((check.options ?? []).flatMap((option) => option.lines)),
  ]
    .filter((line) => !/no notification is sent/i.test(line))
    .slice(0, 2);

  return (
    <section
      aria-label={check.ask ?? check.title}
      className={`rounded-lg border px-3 py-2 ${BOX[check.sev]}`}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${icon.cls}`}
        >
          {icon.mark}
        </span>
        <b className="min-w-0 text-[12px] text-[#111827]">
          {!check.decision && check.ask ? check.ask : check.title}
        </b>
        {!check.decision && !locked && check.options && !picked ? (
          <span className="ml-auto flex flex-wrap gap-1.5">
            {check.options.map((option) => (
              <Button
                key={option.choice}
                size="sm"
                variant={option.recommended ? "default" : "outline"}
                className="h-7 px-2.5 text-[11px]"
                disabled={busy}
                title={option.lines.join(" · ")}
                onClick={() =>
                  option.needsReason
                    ? setPicked(option)
                    : onChoose(option.choice, "")
                }
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                {option.title}
              </Button>
            ))}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-[11px] leading-4 text-[#6b5d50]">
        {!check.decision && check.ask && check.options?.length !== 1 ? (
          <b className="text-[#3d3530]">{check.title}. </b>
        ) : null}
        {check.help}
        {check.waitNote ? <b> {check.waitNote}</b> : null}
        {!check.decision && notes.length && !picked ? (
          <span className="text-[#8a7f72]"> {notes.join(" · ")}</span>
        ) : null}
      </p>
      {check.decision ? (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[#3d3530]">
          <span>
            You chose: <b>{answered?.title ?? check.decision.choice}</b>
          </span>
          {!locked ? (
            <button
              type="button"
              className="font-medium underline"
              disabled={busy}
              onClick={onUndo}
            >
              Change
            </button>
          ) : null}
        </div>
      ) : null}
      {picked ? (
        <ReasonForm
          label={`Reason for “${picked.title}”`}
          placeholder="Why is this acceptable?"
          busy={busy}
          onCancel={() => setPicked(null)}
          onConfirm={(reason) => {
            onChoose(picked.choice, reason);
            setPicked(null);
          }}
        />
      ) : null}
    </section>
  );
}
