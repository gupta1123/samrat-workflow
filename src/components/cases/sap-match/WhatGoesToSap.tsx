"use client";

import type { LineResult, MatchResult } from "@/lib/sap-match/types";
import { formatDate, inr, qty } from "./format";
import { SAP_TERMS } from "@/lib/sap-match/terminology";
import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { DraftHeaderFields } from "./DraftHeaderFields";
import type { PostedSapDetails } from "@/lib/sap-posted-details";
import { SavedPostingCard } from "./SavedPostingPreview";

// The exact document that will be created in SAP, laid out like the invoice
// itself: who it is for and its references, the lines, then the totals. The
// total and the create action sit right below it.
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
  const [expanded, setExpanded] = useState(true);
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
  const rows = plan.lines.map((line) => {
    const rate = line.unitPrice ?? priceOf(line.baseEntry, line.baseLine);
    const value = line.lineTotal ?? (rate !== null ? rate * line.quantity : null);
    return { line, rate, value };
  });
  const itemsTotal = rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
  const differs =
    plan.difference !== null && Math.abs(plan.difference) > 0.005;
  const rounding = differs && Math.abs(plan.difference!) <= 1;

  return (
    <section className="overflow-hidden rounded-xl border border-[#e0d8cc] bg-white shadow-[0_1px_2px_rgba(43,26,16,0.04)]">
      <details
        open
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-[12px] font-semibold text-[#111827] [&::-webkit-details-marker]:hidden">
          <span>{saved ? "Saved A/P Invoice Draft Preview" : "A/P Invoice Draft"}</span>
          <span className="rounded-full bg-[#f2efe9] px-2 py-0.5 text-[10px] font-medium text-[#6b5d50]">
            {saved ? "Submitted" : "Not created yet"}
          </span>
          <span className="ml-auto flex items-center gap-1 text-[11px] font-medium text-[#6b4a33]">
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </span>
        </summary>

        <div className="border-t border-[#ece6dc] bg-[#faf8f4] p-3">
          <article
            aria-label="A/P Invoice Draft"
            className="overflow-hidden rounded-lg border border-[#e0d8cc] bg-white"
          >
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[#ece6dc] px-4 py-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[#8a7f72]">
                  Supplier
                </div>
                <div className="text-[13px] font-semibold text-[#111827]">
                  {vendorLabel}
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

            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-[11px]">
                <thead>
                  <tr className="border-b border-[#e0d8cc] bg-[#faf8f4] text-left text-[10px] uppercase tracking-wider text-[#8a7f72]">
                    <th className="w-8 px-4 py-2 font-semibold">#</th>
                    <th className="py-2 pr-3 font-semibold">Item</th>
                    <th className="py-2 pr-3 font-semibold">Base document</th>
                    <th className="py-2 pr-3 text-right font-semibold">
                      Quantity
                    </th>
                    <th className="py-2 pr-3 text-right font-semibold">
                      Unit price
                    </th>
                    <th className="py-2 pr-4 text-right font-semibold">
                      Value
                    </th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {rows.map(({ line, rate, value }, index) => (
                    <tr
                      key={index}
                      className="border-b border-[#f0ece4] align-top last:border-0"
                    >
                      <td className="px-4 py-2 text-[#8a7f72]">{index + 1}</td>
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
                      <td className="py-2 pr-4 text-right font-medium text-[#111827]">
                        {inr(value)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <footer className="grid gap-4 border-t border-[#ece6dc] px-4 py-3 sm:grid-cols-[1fr_minmax(0,16rem)]">
              <div className="min-w-0">
                {caseId && expanded ? (
                  <DraftHeaderFields caseId={caseId} />
                ) : null}
              </div>
              <dl className="space-y-1 text-[11px] tabular-nums">
                <div className="flex justify-between gap-3">
                  <dt className="text-[#8a7f72]">Items</dt>
                  <dd className="text-[#3d3530]">{inr(itemsTotal)}</dd>
                </div>
                {plan.freightExpense ? (
                  <div className="flex justify-between gap-3">
                    <dt className="text-[#8a7f72]">Freight charge</dt>
                    <dd className="text-[#3d3530]">{inr(plan.freightExpense)}</dd>
                  </div>
                ) : null}
                {plan.freightExcluded ? (
                  <div className="flex justify-between gap-3 text-[#8a7f72]">
                    <dt>Freight excluded (separate invoice)</dt>
                    <dd>{inr(plan.freightExcluded)}</dd>
                  </div>
                ) : null}
                <div className="-mx-1 flex justify-between gap-3 rounded-md bg-[#f6f3ee] px-2 py-1.5 text-[12px] font-semibold text-[#111827]">
                  <dt>Total before tax</dt>
                  <dd>{inr(plan.bookedTaxable)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[#8a7f72]">Tax</dt>
                  <dd className="text-[#8a7f72]">Added by SAP</dd>
                </div>
              </dl>
            </footer>
          </article>
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[#ece6dc] px-4 py-3">
        {differs ? (
          rounding ? (
            <span className="text-[11px] text-[#24583e]">
              ✓ Matches invoice {inr(plan.invoiceTaxable)} (rounding{" "}
              {inr(plan.difference)})
            </span>
          ) : (
            <span className="text-[11px] text-[#9a5a0a]">
              Differs from invoice {inr(plan.invoiceTaxable)} by{" "}
              {inr(plan.difference)}
            </span>
          )
        ) : (
          <span className="text-[11px] text-[#24583e]">
            ✓ Matches invoice {inr(plan.invoiceTaxable)}
          </span>
        )}
        <div className="ml-auto min-w-0">{actions}</div>
      </div>

    </section>
  );
}
