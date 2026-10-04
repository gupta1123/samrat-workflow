"use client";

import Link from "next/link";
import { Check, CheckCircle2, FileText, ArrowRight, Minus } from "lucide-react";
import type { PostedSapDetails } from "@/lib/sap-posted-details";
import { MatchLineCard } from "./MatchLineCard";
import { WhatGoesToSap } from "./WhatGoesToSap";
import { formatDate, qty } from "./format";
import { SAP_TERMS, sapMatchPresentation } from "@/lib/sap-match/terminology";
import { truthfulChecks } from "@/lib/sap-match/evidence";
import { SupplierEvidence } from "./MatchingEvidence";

function money(value: number | null, currency: string | null) {
  if (value === null) return "—";
  return `${currency === "INR" ? "₹" : currency ? `${currency} ` : ""}${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value)}`;
}
function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
const readOnly = () => {};

export function PostedInvoice({
  caseId,
  documentNumber,
  environment,
  details,
}: {
  caseId: string;
  documentNumber: string;
  environment: string;
  details?: PostedSapDetails;
}) {
  const savedMatch = details?.match;
  const match = savedMatch
    ? {
        ...savedMatch,
        result: sapMatchPresentation(
          { ...savedMatch.result, checks: truthfulChecks(savedMatch.result) },
          [
            savedMatch.invoice.vendorName ?? "",
            savedMatch.vendor?.cardName ?? "",
            ...savedMatch.invoice.lines.map((line) => line.description ?? ""),
          ],
        ),
      }
    : null;
  const vendor = details?.vendorName ?? details?.vendorCode;
  return (
    <div className="space-y-4 px-4 py-3">
      <section className="flex flex-wrap items-start gap-3 rounded-xl border border-[#c4dfcf] bg-[#f1f8f4] px-4 py-4">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[#2c6a4f]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[13px] font-semibold text-[#111827]">
              Posted as A/P Invoice {documentNumber}
            </h2>
            <span className="rounded-full bg-[#e9f4ee] px-2 py-0.5 text-[10px] font-semibold text-[#2c6a4f]">
              Posted
            </span>
          </div>
          <p className="mt-1 text-[11px] text-[#6b5d50]">
            {vendor ? `${vendor} · ` : ""}
            {details?.invoiceNumber
              ? `Vendor Ref. No. ${details.invoiceNumber} · `
              : ""}
            SAP {environment === "test" ? "Test" : "Live"}
          </p>
          <p className="mt-1 text-[11px] text-[#2c6a4f]">
            This invoice has been posted. Do not create or post it again.
          </p>
        </div>
        {details?.nextCaseId ? (
          <Link
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#2b1a10] px-3 py-2 text-[11px] font-medium text-white"
            href={`/cases/${details.nextCaseId}/mismatches?tab=sap`}
          >
            Next invoice <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        ) : (
          <Link
            className="text-[11px] font-medium text-[#6b4a33] underline"
            href="/cases"
          >
            Back to invoices
          </Link>
        )}
      </section>

      {details ? (
        <section className="rounded-xl border border-[#e0d8cc] bg-white px-4 py-3">
          <h3 className="text-[12px] font-semibold text-[#111827]">
            Posting details
          </h3>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-[11px] sm:grid-cols-3">
            {[
              [SAP_TERMS.postingDate, formatDate(details.postingDate)],
              [SAP_TERMS.documentDate, formatDate(details.invoiceDate)],
              ["Draft Entry No.", details.draftNumber ?? "—"],
              ["Material form", details.materialForm ?? "—"],
              ["Document Total", money(details.total, details.currency)],
              ["Net payable", money(details.netPayable, details.currency)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-[#8a7f72]">{label}</dt>
                <dd className="mt-0.5 font-medium tabular-nums text-[#111827]">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          {details.bases.length ? (
            <div className="mt-3 border-t border-[#f0ece4] pt-3 text-[11px] text-[#3d3530]">
              Base Document References:{" "}
              {details.bases
                .map(
                  (base) =>
                    `${base.kind === "GRPO" ? SAP_TERMS.grpo : "PO"} ${base.number}`,
                )
                .join(", ")}
              .
            </div>
          ) : null}
          <p className="mt-2 text-[10px] leading-4 text-[#8a7f72]">
            These are saved posting records. GRPO closure, payment settlement
            and current stock are not checked here.
          </p>
          {details.recordedAt ? (
            <p className="mt-1 text-[10px] text-[#8a7f72]">
              Last recorded in this app: {timestamp(details.recordedAt)}
            </p>
          ) : null}
        </section>
      ) : null}

      {details?.lines.length ? (
        <section className="overflow-hidden rounded-xl border border-[#e0d8cc] bg-white px-4 py-3">
          <h3 className="text-[12px] font-semibold text-[#111827]">
            Posted invoice lines
          </h3>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-[11px]">
              <thead className="border-b border-[#e0d8cc] text-[#8a7f72]">
                <tr>
                  <th className="py-2 font-medium">Item</th>
                  <th className="py-2 text-right font-medium">Quantity</th>
                  <th className="py-2 text-right font-medium">Unit Price</th>
                  <th className="py-2 text-right font-medium">Before tax</th>
                </tr>
              </thead>
              <tbody>
                {details.lines.map((line, index) => (
                  <tr
                    key={index}
                    className="border-b border-[#f0ece4] last:border-0"
                  >
                    <td className="py-2">
                      {line.description ?? line.itemCode ?? "Service"}
                      <div className="font-mono text-[10px] text-[#8a7f72]">
                        {line.itemCode}
                      </div>
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {qty(line.quantity)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {money(line.rate, details.currency)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {money(line.amount, details.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {match ? (
        <>
          <div>
            <h3 className="text-[12px] font-semibold text-[#111827]">
              Comparison saved before posting
            </h3>
            <p className="mt-1 text-[11px] text-[#8a7f72]">
              The match used to create the draft. Its GRPO quantities describe
              that saved check.
            </p>
          </div>
          <SupplierEvidence
            invoice={match.invoice}
            vendor={match.vendor}
            result={match.result}
          />
          {match.result.lines.map((line) => (
            <MatchLineCard
              key={line.index}
              caseId={caseId}
              invoice={match.invoice}
              line={line}
              checks={match.result.checks.filter(
                (check) => check.lineIndex === line.index,
              )}
              locked
              busy={false}
              vendorFound={Boolean(match.vendor)}
              onChoose={readOnly}
              onUndo={readOnly}
              onAllocate={readOnly}
              onResetAllocation={readOnly}
              onLink={readOnly}
            />
          ))}
          <WhatGoesToSap
            result={match.result}
            lines={match.result.lines}
            vendorLabel={
              match.vendor
                ? `${match.vendor.cardName} (${match.vendor.cardCode})`
                : "Vendor"
            }
            saved
          />
          <details className="rounded-xl border border-[#e0d8cc] bg-white px-4 py-3 text-[11px]">
            <summary className="cursor-pointer font-medium text-[#6b4a33]">
              Saved checks and decisions ({match.result.checks.length})
            </summary>
            <ul className="mt-3 space-y-2">
              {match.result.checks.map((check) => (
                <li
                  key={check.id}
                  className="flex items-start gap-2 text-[#3d3530]"
                >
                  {check.sev === "unchecked" ? (
                    <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#6b5d50]" />
                  ) : (
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#2c6a4f]" />
                  )}
                  <div>
                    <span className="mr-1.5 text-[10px] font-medium">
                      {check.sev === "unchecked"
                        ? "Not checked"
                        : check.decision
                          ? "Accepted by reviewer"
                          : "Matched"}{" "}
                      ·
                    </span>
                    {check.title}
                    {check.decision ? (
                      <p className="mt-0.5 text-[10px] text-[#8a7f72]">
                        {check.decision.choice}
                        {check.decision.reason
                          ? ` · ${check.decision.reason}`
                          : ""}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <div className="rounded-xl border border-[#e0d8cc] bg-[#fbfaf8] px-4 py-3 text-[11px] leading-4 text-[#6b5d50]">
          The original match comparison was not saved for this older posting.
          The available posting details are shown above; its source documents
          remain on the case.
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-[#e0d8cc] bg-white px-4 py-3">
        <div>
          <h3 className="text-[12px] font-semibold text-[#111827]">
            Posting history
          </h3>
          {details?.history.length ? (
            <ol className="mt-3 space-y-2 text-[11px] text-[#3d3530]">
              {details.history.map((event, index) => (
                <li key={index}>
                  {event.title}
                  <div className="mt-0.5 text-[10px] text-[#8a7f72]">
                    {timestamp(event.at)}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-[11px] text-[#8a7f72]">
              Posting history is not available for this record.
            </p>
          )}
        </div>
        <Link
          className="inline-flex items-center gap-1.5 rounded-lg border border-[#d8d0c5] px-3 py-2 text-[11px] font-medium text-[#6b4a33]"
          href={`/cases/${caseId}`}
        >
          <FileText className="h-3.5 w-3.5" /> View source documents
        </Link>
      </div>
    </div>
  );
}
