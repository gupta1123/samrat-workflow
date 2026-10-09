"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Check,
  Clock,
  Loader2,
  ShieldAlert,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { MatchCheck } from "@/lib/sap-match/types";
import type { PriceReviewDetails } from "@/lib/sap-match/price-review";
import { PriceReviewBlock } from "./PriceReviewBlock";

const TONES = {
  block: {
    box: "border-[#f3c6c0] bg-[#fdf3f1]",
    icon: "text-[#b3261e]",
    Icon: XCircle,
  },
  confirm: {
    box: "border-[#f0d7a6] bg-[#fdf7ea]",
    icon: "text-[#9a5a0a]",
    Icon: ShieldAlert,
  },
  ack: {
    box: "border-[#f0d7a6] bg-[#fdf7ea]",
    icon: "text-[#9a5a0a]",
    Icon: AlertTriangle,
  },
  wait: {
    box: "border-[#dcd5cb] bg-[#f6f3ee]",
    icon: "text-[#5c5650]",
    Icon: Clock,
  },
  pass: {
    box: "border-[#c4dfcf] bg-[#f1f8f4]",
    icon: "text-[#2c6a4f]",
    Icon: Check,
  },
  unchecked: {
    box: "border-[#dcd5cb] bg-[#f6f3ee]",
    icon: "text-[#5c5650]",
    Icon: AlertTriangle,
  },
} as const;

const MIN_REASON = 5;

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
  const [picked, setPicked] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const tone = TONES[check.sev];
  const answered = check.decision
    ? check.options?.find((option) => option.choice === check.decision!.choice)
    : undefined;

  // Already answered and no longer stopping the invoice.
  if (check.decision && !check.open) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#c4dfcf] bg-[#f1f8f4] px-3 py-2 text-[11px] text-[#1b4332]">
        <Check className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">
          Accepted by reviewer · {answered?.title ?? "Confirmed"}
        </span>
        {check.decision.reason ? (
          <span className="text-[#476b58]">· “{check.decision.reason}”</span>
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

  const singleOption = check.options?.length === 1 ? check.options[0] : null;
  if (!check.decision && !locked && singleOption && !singleOption.needsReason) {
    return (
      <div className={`rounded-lg border px-3 py-2 ${tone.box}`}>
        <div className="flex flex-wrap items-start gap-2">
          <tone.Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone.icon}`} />
          <div className="min-w-0 flex-1 basis-[calc(100%-2rem)] sm:basis-auto">
            <p className="text-[12px] font-semibold text-[#111827]">
              {check.ask ?? check.title}
            </p>
            {check.help ? (
              <p className="mt-1 text-[11px] leading-4 text-[#6b5d50]">
                {check.help}
              </p>
            ) : null}
            {check.waitNote ? (
              <p className="mt-1 text-[11px] leading-4 text-[#6b5d50]">
                {check.waitNote}
              </p>
            ) : null}
            {singleOption.lines.length ? (
              <details className="mt-1 text-[11px] text-[#6b5d50]">
                <summary className="w-fit cursor-pointer py-1">
                  Decision details
                </summary>
                <ul className="mt-1 space-y-0.5">
                  {singleOption.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
          <Button
            size="sm"
            variant={singleOption.recommended ? "default" : "outline"}
            className="h-7 px-2.5 text-[11px]"
            disabled={busy}
            onClick={() => onChoose(singleOption.choice, "")}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {singleOption.title}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-lg border px-4 py-3 ${tone.box}`}>
      <div className="flex items-start gap-2.5">
        <tone.Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone.icon}`} />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold leading-5 text-[#111827]">
            {!check.decision && check.ask ? check.ask : check.title}
          </div>
          {!check.decision && check.ask ? (
            <div className="mt-0.5 text-[11px] font-medium leading-4 text-[#3d3530]">
              {check.title}
            </div>
          ) : null}
          {check.help ? (
            <div className="mt-1 text-[11px] leading-4 text-[#6b5d50]">
              {check.help}
            </div>
          ) : null}
          {check.waitNote ? (
            <div className="mt-1 text-[11px] leading-4 text-[#6b5d50]">
              {check.waitNote}
            </div>
          ) : null}

          {check.decision ? (
            <div className="mt-2 flex items-center gap-2 text-[11px] text-[#3d3530]">
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

          {!check.decision && check.options && !locked ? (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {check.options.map((option) => {
                const selected = picked === option.choice;
                return (
                  <div
                    key={option.choice}
                    className={`rounded-md border bg-white p-3 ${option.recommended ? "border-[#2d6a4f]" : "border-[#e0d8cc]"}`}
                  >
                    {option.recommended ? (
                      <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-[#2d6a4f]">
                        Recommended
                      </div>
                    ) : null}
                    <div className="text-[11px] font-semibold text-[#111827]">
                      {option.title}
                    </div>
                    <ul className="mt-1 space-y-0.5 text-[10px] leading-4 text-[#6b5d50]">
                      {option.lines.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                    {option.needsReason && selected ? (
                      <textarea
                        className="mt-2 block w-full rounded-md border border-[#cfc4b8] bg-white px-2 py-1.5 text-[11px] text-[#111827] outline-none focus:border-[#2d6a4f] focus:ring-1 focus:ring-[#2d6a4f]"
                        rows={2}
                        maxLength={500}
                        placeholder="Why is this acceptable? This is saved in the audit trail."
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                      />
                    ) : null}
                    <Button
                      size="sm"
                      variant={option.recommended ? "default" : "outline"}
                      className="mt-2 h-7 px-2.5 text-[11px]"
                      disabled={
                        busy ||
                        (option.needsReason &&
                          selected &&
                          reason.trim().length < MIN_REASON)
                      }
                      onClick={() => {
                        if (option.needsReason && !selected) {
                          setPicked(option.choice);
                          return;
                        }
                        onChoose(
                          option.choice,
                          option.needsReason ? reason.trim() : "",
                        );
                        setPicked(null);
                        setReason("");
                      }}
                    >
                      {busy ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : null}
                      {option.needsReason && !selected
                        ? "Choose this"
                        : option.needsReason
                          ? "Confirm with reason"
                          : "Choose this"}
                    </Button>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
