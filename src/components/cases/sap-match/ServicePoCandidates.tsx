"use client";
import type { LineResult, MatchInvoiceLine } from "@/lib/sap-match/types";
import { inr } from "./format";

export function ServicePoCandidates({
  line,
  invoiceLine,
  disabled,
  onAllocate,
  onReset,
}: {
  line: LineResult;
  invoiceLine: MatchInvoiceLine | undefined;
  disabled: boolean;
  onAllocate: (index: number, allocations: Record<string, number>) => void;
  onReset: (index: number) => void;
}) {
  return (
    <div className="space-y-2 text-[11px]">
      <h4 className="font-semibold">Service PO lines</h4>
      <p className="text-[#6b5d50]">
        Compare the invoice service with the SAP item or account, then select
        the correct PO line. No GRPO, vehicle or weight is required.
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
          <span className="min-w-0 flex-1">
            <strong>
              PO {candidate.docNum} · SAP line {candidate.lineNum}
            </strong>
            <span className="block">{candidate.note || "Service PO"}</span>
            <span className="my-2 grid gap-3 rounded-md bg-[#faf8f4] p-2 sm:grid-cols-2">
              <span className="min-w-0 break-words">
                <strong className="block">From the invoice</strong>
                <span className="block">
                  Code:{" "}
                  {invoiceLine?.vendorItemCode || "Not printed / extracted"}
                </span>
                <span className="block">
                  Name: {invoiceLine?.description || "Not recorded"}
                </span>
                <span className="block">Amount: {inr(line.invoiceAmount)}</span>
              </span>
              <span className="min-w-0 break-words">
                <strong className="block">From SAP</strong>
                {candidate.documentType === "dDocument_Items" ? (
                  <>
                    <span className="block">Code: {candidate.itemCode}</span>
                    <span className="block">
                      Name: {candidate.itemName || "Not recorded"}
                    </span>
                    <span className="block">Non-stock item</span>
                  </>
                ) : (
                  <span className="block">
                    Service account: {candidate.accountCode || "Not recorded"}
                  </span>
                )}
                <span className="block">Open value: {inr(candidate.open)}</span>
              </span>
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
