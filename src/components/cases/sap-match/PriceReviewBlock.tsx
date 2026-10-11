"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MatchCheck } from "@/lib/sap-match/types";
import type { PriceReviewDetails } from "@/lib/sap-match/price-review";
import { inr } from "./format";
import { ReasonForm } from "./CheckBlock";

const money = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Price outside tolerance: one row with the two choices, one line of numbers.
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
  const accept = check.options?.find(
    (option) => option.effect === "resolve" && option.needsReason,
  );
  const returnOption = check.options?.find(
    (option) => option.effect === "return",
  );
  const source = details.comparisonSource.replace(/^SAP /, "");
  const higher = details.direction === "higher";
  const title =
    source === "PO" || source === "GRPO"
      ? higher
        ? `Price above ${source} tolerance`
        : `Price below ${source} tolerance`
      : "Price outside allowed limit";

  return (
    <section
      aria-label="Price decision"
      className="rounded-lg border border-[#f0d7a6] bg-[#fdf7ea] px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#fdf1dc] text-[10px] font-bold text-[#8a5207]">
          !
        </span>
        <b className="text-[12px] text-[#111827]">{title}</b>
        <span className="text-[11px] text-[#6b5d50]">
          {details.percent.toFixed(2)}% {higher ? "above" : "below"} · allowed{" "}
          {details.tolerancePct}%
        </span>
        {!locked && !accepting ? (
          <span className="ml-auto flex flex-wrap gap-1.5">
            {accept ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-[11px]"
                disabled={busy}
                onClick={() => setAccepting(true)}
              >
                Accept invoice price
              </Button>
            ) : null}
            {returnOption ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2.5 text-[11px]"
                disabled={busy}
                title="Marks this case for supplier correction. Contact the supplier separately; no notification is sent."
                onClick={() => onChoose(returnOption.choice, "")}
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Supplier must correct
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-[11px] leading-4 text-[#6b5d50]">
        {details.valueDifference != null ? (
          <b className="tabular-nums text-[#3d3530]">
            {higher ? "+" : "−"}₹{money.format(details.valueDifference)}
          </b>
        ) : null}{" "}
        before tax ({inr(details.difference)}
        {details.unit ? `/${details.unit}` : ""} {higher ? "higher" : "lower"}
        {details.partialAllocation ? ", allocated quantity" : ""}).
        {details.freightExplains != null ? (
          <>
            {" "}
            <b className="text-[#3d3530]">
              Likely cause: freight billed separately.
            </b>{" "}
            The difference matches the invoice freight of ₹
            {money.format(details.freightExplains)}. If the PO rate includes
            freight, the supplier has not undercharged.
          </>
        ) : null}
      </p>
      {!locked && accepting && accept ? (
        <ReasonForm
          label="Reason for accepting the price difference"
          placeholder={
            details.freightExplains != null
              ? "e.g. Freight billed separately on the invoice"
              : undefined
          }
          busy={busy}
          confirmLabel="Confirm price exception"
          onCancel={() => setAccepting(false)}
          onConfirm={(reason) => onChoose(accept.choice, reason)}
        />
      ) : null}
    </section>
  );
}
