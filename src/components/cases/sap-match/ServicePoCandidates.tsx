"use client";
import type { LineResult } from "@/lib/sap-match/types";
import { inr } from "./format";

export function ServicePoCandidates({
  line,
  disabled,
  onAllocate,
  onReset,
}: {
  line: LineResult;
  disabled: boolean;
  onAllocate: (index: number, allocations: Record<string, number>) => void;
  onReset: (index: number) => void;
}) {
  return (
    <div className="space-y-2 text-[11px]">
      <h4 className="font-semibold">Service PO lines</h4>
      <p className="text-[#6b5d50]">
        Select the PO line covering this service. No GRPO, vehicle or weight is
        required.
      </p>
      {line.candidates.map((candidate) => (
        <label
          key={candidate.key}
          className="flex items-start gap-2 rounded-lg border border-[#e0d8cc] p-2"
        >
          <input
            type="radio"
            name={`service-po-${line.index}`}
            checked={candidate.allocated > 0}
            disabled={
              disabled || Boolean(candidate.rejected) || !line.invoiceAmount
            }
            onChange={() =>
              onAllocate(line.index, { [candidate.key]: line.invoiceAmount! })
            }
          />
          <span>
            <strong>
              PO {candidate.docNum} · SAP line {candidate.lineNum}
            </strong>
            <span className="block">{candidate.note || "Service PO"}</span>
            <span className="block">
              {inr(candidate.open)} open · Invoice {inr(line.invoiceAmount)}
            </span>
            <span className="block text-[#6b5d50]">
              {candidate.rejected ||
                [...candidate.good, ...candidate.bad].join(" · ")}
            </span>
          </span>
        </label>
      ))}
      {line.manual ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onReset(line.index)}
          className="underline"
        >
          Reset PO selection
        </button>
      ) : null}
    </div>
  );
}
