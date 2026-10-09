"use client";

import type { LineResult, MatchResult } from "@/lib/sap-match/types";
import { formatDate, inr, qty } from "./format";
import { SAP_TERMS } from "@/lib/sap-match/terminology";
import { useState, type ReactNode } from "react";
import { DraftHeaderFields } from "./DraftHeaderFields";
import type { PostedSapDetails } from "@/lib/sap-posted-details";
import { SavedPostingCard } from "./SavedPostingPreview";

// The exact document that will be created in SAP, before anything is created.
export function WhatGoesToSap({
  caseId,
  result,
  lines,
  vendorLabel,
  saved = false,
  savedDetails,
  actions,
}: {
  caseId?: string;
  result: MatchResult;
  lines: LineResult[];
  vendorLabel: string;
  saved?: boolean;
  savedDetails?: PostedSapDetails;
  actions?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  if (saved && caseId && savedDetails)
    return <SavedPostingCard caseId={caseId} details={savedDetails} />;
  const plan = result.payload;
  if (!plan) return null;
  const priceOf = (baseEntry: number, baseLine: number) =>
    lines
      .flatMap((line) => line.candidates)
      .find(
        (candidate) =>
          candidate.docEntry === baseEntry && candidate.lineNum === baseLine,
      )?.price ?? null;
  const nameOf = (index: number) =>
    lines.find((line) => line.index === index)?.itemName ?? "";

  return (
    <section className="overflow-hidden rounded-xl border border-[#e0d8cc] bg-white shadow-[0_1px_2px_rgba(43,26,16,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <div>
          <p className="text-[12px] font-semibold text-[#111827]">
            {saved ? "Saved draft total" : "Draft total"}:{" "}
            {inr(plan.bookedTaxable)}{" "}
            <span className="ml-1 font-normal text-[#6b5d50]">before tax</span>
          </p>
          {plan.difference !== null && Math.abs(plan.difference) > 0.005 ? (
            <p className="mt-1 text-[11px] text-[#9a5a0a]">
              Scanned invoice: {inr(plan.invoiceTaxable)} · Difference:{" "}
              {inr(plan.difference)}
            </p>
          ) : null}
          <p className="mt-1 text-[11px] text-[#6b5d50]">
            {saved
              ? "Recorded at draft creation; current SAP balances may differ."
              : "Tax is calculated by SAP. Creating a draft does not post an invoice."}
          </p>
        </div>
        {actions}
      </div>
      <details
        className="border-t border-[#ece6dc]"
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="cursor-pointer px-4 py-2 text-[11px] font-medium text-[#6b4a33]">
          {saved
            ? "Saved A/P Invoice Draft Preview"
            : "View draft posting details"}
        </summary>
        <header className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8a7f72]">
              {saved
                ? "Saved A/P Invoice Draft Preview"
                : "A/P Invoice Draft Preview"}
            </div>
            <div className="mt-0.5 text-[13px] font-semibold text-[#111827]">
              A/P Invoice Draft · {vendorLabel}
            </div>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-right text-[11px]">
            <dt className="text-[#8a7f72]">{SAP_TERMS.vendorRef}</dt>
            <dd className="font-semibold tabular-nums text-[#111827]">
              {plan.numAtCard}
            </dd>
            <dt className="text-[#8a7f72]" title="Vendor invoice date">
              {SAP_TERMS.documentDate}
            </dt>
            <dd className="tabular-nums text-[#111827]">
              {formatDate(plan.taxDate)}
            </dd>
            <dt className="text-[#8a7f72]">{SAP_TERMS.postingDate}</dt>
            <dd className="tabular-nums text-[#111827]">
              {formatDate(plan.docDate)}
            </dd>
          </dl>
        </header>
        {caseId && expanded && !saved ? (
          <div className="border-t border-[#ece6dc] px-4 py-3">
            <DraftHeaderFields caseId={caseId} />
          </div>
        ) : null}
        <div className="overflow-x-auto px-4">
          <table className="w-full min-w-[520px] text-[11px]">
            <thead>
              <tr className="border-b border-[#e0d8cc] text-left text-[10px] uppercase tracking-wider text-[#8a7f72]">
                <th className="py-2 pr-3 font-semibold">Item</th>
                <th className="py-2 pr-3 font-semibold">Base Document</th>
                <th className="py-2 pr-3 text-right font-semibold">Quantity</th>
                <th className="py-2 pr-3 text-right font-semibold">
                  Unit Price
                </th>
                <th className="py-2 text-right font-semibold">Value</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {plan.lines.map((line, index) => {
                const rate =
                  line.unitPrice ?? priceOf(line.baseEntry, line.baseLine);
                const value =
                  line.lineTotal ??
                  (rate !== null ? rate * line.quantity : null);
                return (
                  <tr
                    key={index}
                    className="border-b border-[#f0ece4] align-top last:border-0"
                  >
                    <td className="py-2 pr-3">
                      <div className="font-medium text-[#111827]">
                        {nameOf(line.invoiceLineIndex) || line.itemCode}
                      </div>
                      <div className="font-mono text-[10px] text-[#8a7f72]">
                        {line.itemCode}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-[#3d3530]">
                      {line.baseType === 20 ? SAP_TERMS.grpo : "PO"}{" "}
                      {line.baseDocNum}
                      <div className="text-[10px] text-[#8a7f72]">
                        line {line.baseLine + 1}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {line.lineTotal !== null ? "—" : qty(line.quantity)}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {line.lineTotal !== null ? "—" : inr(rate)}
                      {line.unitPrice !== null ? (
                        <div className="text-[10px] text-[#9a5a0a]">
                          Vendor Invoice Unit Price
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2 text-right font-medium text-[#111827]">
                      {inr(value)}
                    </td>
                  </tr>
                );
              })}
              {plan.freightExpense ? (
                <tr className="border-t border-[#f0ece4]">
                  <td
                    className="py-2 pr-3 font-medium text-[#111827]"
                    colSpan={4}
                  >
                    Freight charge
                  </td>
                  <td className="py-2 text-right font-medium text-[#111827]">
                    {inr(plan.freightExpense)}
                  </td>
                </tr>
              ) : null}
              {plan.freightExcluded ? (
                <tr className="border-t border-[#f0ece4] text-[#8a7f72]">
                  <td className="py-2 pr-3" colSpan={4}>
                    Freight excluded (separate invoice)
                  </td>
                  <td className="py-2 text-right">
                    {inr(plan.freightExcluded)}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <dl className="ml-auto max-w-xs space-y-1 px-4 pb-4 pt-3 text-[11px] tabular-nums">
          <div className="flex justify-between">
            <dt className="text-[#8a7f72]">Draft Total (before tax)</dt>
            <dd className="font-medium text-[#111827]">
              {inr(plan.bookedTaxable)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[#8a7f72]">Vendor Invoice (before tax)</dt>
            <dd className="font-medium text-[#111827]">
              {inr(plan.invoiceTaxable)}
            </dd>
          </div>
          {plan.difference !== null && Math.abs(plan.difference) > 0.005 ? (
            <div className="flex justify-between">
              <dt className="text-[#8a7f72]">Difference</dt>
              <dd
                className={`font-medium ${Math.abs(plan.difference) > 10 ? "text-[#9a5a0a]" : "text-[#111827]"}`}
              >
                {inr(plan.difference)}
              </dd>
            </div>
          ) : null}
          <div className="pt-1 text-[10px] leading-4 text-[#8a7f72]">
            {saved
              ? "Saved when the draft was created. This preview does not show current GRPO balances or subsequent SAP changes."
              : "SAP works out tax from the linked documents. Nothing is created until you choose to create the draft."}
          </div>
        </dl>
      </details>
    </section>
  );
}
