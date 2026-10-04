"use client";

import { useId, useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MatchCheck } from "@/lib/sap-match/types";
import type { PriceReviewDetails } from "@/lib/sap-match/price-review";
import { inr } from "./format";

const MIN_REASON = 5;
const money = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function PriceReviewBlock({
  check,
  details,
  locked,
  busy,
  onChoose,
}: {
  check: MatchCheck;
  details: PriceReviewDetails;
  locked: boolean;
  busy: boolean;
  onChoose: (choice: string, reason: string) => void;
}) {
  const [accepting, setAccepting] = useState(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const accept = check.options?.find(
    (option) => option.effect === "resolve" && option.needsReason,
  );
  const returnOption = check.options?.find(
    (option) => option.effect === "return",
  );

  return (
    <section
      aria-label="Price difference review"
      className="rounded-lg border border-[#f0d7a6] bg-[#fdf7ea] px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#9a5a0a]" />
        <div className="min-w-0 flex-1">
          <h4 className="text-[11px] font-semibold text-[#111827]">
            Price difference needs review
          </h4>
          <p className="mt-1 text-[11px] leading-4 text-[#3d3530]">
            Scanned invoice is{" "}
            <strong>
              {inr(details.difference)}
              {details.unit ? `/${details.unit}` : ""} {details.direction}
            </strong>{" "}
            than the {details.comparisonSource}
          </p>
          <p className="mt-0.5 text-[10px] leading-4 text-[#6b5d50]">
            {details.percent.toFixed(2)}% difference · Allowed difference:{" "}
            {details.tolerancePct}%
          </p>
          {details.valueDifference != null ? (
            <p className="mt-1 text-[10px] leading-4 text-[#6b5d50]">
              {details.partialAllocation ? "Allocated value" : "Invoice value"}{" "}
              is ₹{money.format(details.valueDifference)} {details.direction}{" "}
              before tax
            </p>
          ) : null}

          {!locked && !accepting ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {accept ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-[11px]"
                  disabled={busy}
                  onClick={() => setAccepting(true)}
                >
                  Use scanned invoice price
                </Button>
              ) : null}
              {returnOption ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-[11px]"
                  disabled={busy}
                  onClick={() => onChoose(returnOption.choice, "")}
                >
                  Return for correction
                </Button>
              ) : null}
            </div>
          ) : null}

          {!locked && accepting && accept ? (
            <div className="mt-2 border-t border-[#f0d7a6] pt-2">
              <label
                htmlFor={reasonId}
                className="text-[10px] font-medium text-[#3d3530]"
              >
                Reason for accepting the price difference
              </label>
              <textarea
                id={reasonId}
                autoFocus
                required
                rows={2}
                maxLength={500}
                aria-describedby={`${reasonId}-help`}
                className="mt-1 block w-full rounded-md border border-[#cfc4b8] bg-white px-2 py-1.5 text-[11px] text-[#111827] outline-none focus:border-[#2d6a4f] focus:ring-1 focus:ring-[#2d6a4f]"
                value={reason}
                disabled={busy}
                onChange={(event) => setReason(event.target.value)}
              />
              <p
                id={`${reasonId}-help`}
                className="mt-1 text-[9px] text-[#6b5d50]"
              >
                Required · at least 5 characters · saved in the audit trail
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-2.5 text-[11px]"
                  disabled={busy || reason.trim().length < MIN_REASON}
                  onClick={() => onChoose(accept.choice, reason.trim())}
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  Confirm price exception
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2.5 text-[11px]"
                  disabled={busy}
                  onClick={() => {
                    setAccepting(false);
                    setReason("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
