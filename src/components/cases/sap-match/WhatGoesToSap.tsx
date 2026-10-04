"use client";

import type { LineResult, MatchResult } from "@/lib/sap-match/types";
import { formatDate, inr, qty } from "./format";
import { SAP_TERMS } from "@/lib/sap-match/terminology";

// The exact document that will be created in SAP, before anything is created.
export function WhatGoesToSap({
  result,
  lines,
  vendorLabel,
  saved = false,
}: {
  result: MatchResult;
  lines: LineResult[];
  vendorLabel: string;
  saved?: boolean;
}) {
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
      <div className="h-1 bg-gradient-to-r from-[#2b1a10] via-[#6b4a33] to-[#c9a57f]" />
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
      <div className="overflow-x-auto px-4">
        <table className="w-full min-w-[520px] text-[11px]">
          <thead>
            <tr className="border-b border-[#e0d8cc] text-left text-[10px] uppercase tracking-wider text-[#8a7f72]">
              <th className="py-2 pr-3 font-semibold">Item</th>
              <th className="py-2 pr-3 font-semibold">Base Document</th>
              <th className="py-2 pr-3 text-right font-semibold">Quantity</th>
              <th className="py-2 pr-3 text-right font-semibold">Unit Price</th>
              <th className="py-2 text-right font-semibold">Value</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {plan.lines.map((line, index) => {
              const rate =
                line.unitPrice ?? priceOf(line.baseEntry, line.baseLine);
              const value =
                line.lineTotal ?? (rate !== null ? rate * line.quantity : null);
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
                <td className="py-2 text-right">{inr(plan.freightExcluded)}</td>
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
            ? "Saved when the draft was created. Final posting details are shown above."
            : "SAP works out tax from the linked documents. Nothing is created until you choose to create the draft."}
        </div>
      </dl>
    </section>
  );
}
