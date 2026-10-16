"use client";

import { useState } from "react";
import type {
  MatchInvoice,
  LineResult,
  MatchCheck,
} from "@/lib/sap-match/types";
import { inr, qty } from "./format";
import { CheckBlock } from "./CheckBlock";
import { ServicePoCandidates } from "./ServicePoCandidates";
import { MatchUpdateNotice } from "./MatchUpdateContext";

/** Service presentation only. Allocation, validation and matching remain in the engine. */
export function ServiceLineReview({
  invoice,
  line,
  checks,
  lineCount,
  busy,
  locked,
  onChoose,
  onUndo,
  onAllocate,
  onResetAllocation,
}: {
  invoice: MatchInvoice;
  line: LineResult;
  checks: MatchCheck[];
  lineCount: number;
  busy: boolean;
  locked: boolean;
  onChoose: (check: MatchCheck, choice: string, reason: string) => void;
  onUndo: (check: MatchCheck) => void;
  onAllocate: (index: number, allocations: Record<string, number>) => void;
  onResetAllocation: (index: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const source = invoice.lines.find((entry) => entry.index === line.index);
  const selected = line.candidates.find((candidate) => candidate.allocated > 0);
  const issues = checks.filter(
    (check) => check.lineIndex === line.index && (check.open || check.decision),
  );
  const matched = Boolean(selected) && !issues.some((check) => check.open);
  const title = source?.description || `Service ${line.index + 1}`;
  const itemBased = selected?.documentType === "dDocument_Items";
  const cellClass = "px-3 py-2 text-left align-top break-words";
  return (
    <section
      aria-label={`Service line ${line.index + 1}`}
      className="overflow-hidden rounded-xl border border-[#e0d8cc] bg-white shadow-[0_1px_2px_rgba(43,26,16,0.04)]"
    >
      <header className="flex items-start justify-between gap-3 border-b border-[#ece6dc] px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-[12px] font-semibold text-[#111827]">{title}</h3>
          <p className="mt-1 text-[11px] text-[#6b5d50]">
            Service
            {selected
              ? ` · PO ${selected.docNum} · line ${selected.lineNum + 1}`
              : " · No PO line linked"}
            {lineCount > 1 ? ` · ${line.index + 1} of ${lineCount}` : ""}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-medium ${matched ? "bg-[#e8f3ec] text-[#24583e]" : "bg-[#fdf1dc] text-[#8a5207]"}`}
        >
          {matched ? "Matched" : selected ? "Needs review" : "Choose PO line"}
        </span>
      </header>
      <div className="space-y-3 px-4 py-3">
        <MatchUpdateNotice lineIndex={line.index} />
        <table className="w-full table-fixed text-[11px]">
          <thead>
            <tr className="border-b border-[#ece6dc] text-[#6b5d50]">
              <th className={`${cellClass} w-24`} scope="col">
                <span className="sr-only">Field</span>
              </th>
              <th className={cellClass} scope="col">
                From the invoice
              </th>
              <th className={cellClass} scope="col">
                From SAP{selected ? ` · PO ${selected.docNum}` : ""}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-[#f0ece4]">
              <th
                scope="row"
                className={`${cellClass} font-normal text-[#6b5d50]`}
              >
                Service
              </th>
              <td className={cellClass}>{title}</td>
              <td className={cellClass}>
                {selected?.poEvidence?.description ||
                  selected?.itemName ||
                  (selected ? "See PO details" : "No PO line linked")}
              </td>
            </tr>
            <tr className="border-b border-[#f0ece4]">
              <th
                scope="row"
                className={`${cellClass} font-normal text-[#6b5d50]`}
              >
                PO reference
              </th>
              <td className={cellClass}>
                {invoice.poReferences.join(", ") || "Not printed"}
              </td>
              <td className={cellClass}>
                {selected
                  ? `PO ${selected.docNum} · line ${selected.lineNum + 1}`
                  : "—"}
              </td>
            </tr>
            {invoice.servicePeriod ? (
              <tr className="border-b border-[#f0ece4]">
                <th
                  scope="row"
                  className={`${cellClass} font-normal text-[#6b5d50]`}
                >
                  Service period
                </th>
                <td className={cellClass} colSpan={2}>
                  {invoice.servicePeriod}
                </td>
              </tr>
            ) : null}
            <tr>
              <th
                scope="row"
                className={`${cellClass} font-normal text-[#6b5d50]`}
              >
                Amount
              </th>
              <td className={`${cellClass} font-semibold tabular-nums`}>
                {inr(line.invoiceAmount)}
              </td>
              <td className={`${cellClass} font-semibold tabular-nums`}>
                {selected ? inr(selected.allocated) : "—"}
                {selected ? (
                  <span className="mt-1 block text-[10px] font-normal text-[#6b5d50]">
                    Available before this bill: {inr(selected.open)}
                  </span>
                ) : null}
              </td>
            </tr>
            {itemBased && source?.quantity != null ? (
              <tr>
                <th
                  scope="row"
                  className={`${cellClass} font-normal text-[#6b5d50]`}
                >
                  Billing units
                </th>
                <td className={cellClass}>
                  {qty(source.quantity)} {source.unit}
                </td>
                <td className={cellClass}>
                  {qty(selected.poEvidence?.openQuantity)} available
                </td>
              </tr>
            ) : null}
            {itemBased && source?.rate != null ? (
              <tr>
                <th
                  scope="row"
                  className={`${cellClass} font-normal text-[#6b5d50]`}
                >
                  Unit price
                </th>
                <td className={cellClass}>{inr(source.rate)}</td>
                <td className={cellClass}>{inr(selected.price)}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {issues
          .filter((check) => !locked || check.decision)
          .map((check) => (
            <CheckBlock
              key={check.id}
              check={check}
              locked={locked}
              busy={busy}
              onChoose={(choice, reason) => onChoose(check, choice, reason)}
              onUndo={() => onUndo(check)}
            />
          ))}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <details className="min-w-0 flex-1 text-[11px] text-[#6b5d50]">
            <summary className="cursor-pointer font-medium text-[#6b4a33]">
              View matching details
            </summary>
            <div className="mt-2 space-y-1 break-words">
              {selected ? (
                <>
                  <p>SAP account: {selected.accountCode || "Not recorded"}</p>
                  {selected.itemCode ? (
                    <p>
                      SAP item: {selected.itemCode} · {selected.itemName}
                    </p>
                  ) : null}
                  {selected.poEvidence?.lineRemarks ? (
                    <p>Line remarks: {selected.poEvidence.lineRemarks}</p>
                  ) : null}
                  {selected.poEvidence?.headerRemarks ? (
                    <p>PO remarks: {selected.poEvidence.headerRemarks}</p>
                  ) : null}
                  <p>{[...selected.good, ...selected.bad].join(" · ")}</p>
                </>
              ) : (
                <p>
                  Select the correct supplier PO line to compare this service.
                </p>
              )}
              {source?.source?.fileName || invoice.source?.fileName ? (
                <p>
                  Invoice source:{" "}
                  {source?.source?.fileName || invoice.source?.fileName} ·{" "}
                  {source?.source?.pageLabel ||
                    invoice.source?.pageLabel ||
                    "PDF"}
                </p>
              ) : null}
            </div>
          </details>
          {selected && !locked && line.candidates.length ? (
            <button
              type="button"
              disabled={busy}
              className="text-[11px] font-medium text-[#6b4a33] underline disabled:opacity-50"
              aria-expanded={editing}
              onClick={() => setEditing(!editing)}
            >
              {editing ? "Cancel change" : "Change PO line"}
            </button>
          ) : null}
        </div>
        {(!selected || editing) && !locked && line.candidates.length ? (
          <div className="rounded-lg border border-[#e0d8cc] bg-[#faf8f4] p-3">
            <ServicePoCandidates
              compact
              line={line}
              invoiceLine={source}
              invoicePoReferences={invoice.poReferences}
              disabled={busy}
              onAllocate={onAllocate}
              onReset={onResetAllocation}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
