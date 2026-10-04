"use client";

import type {
  LineResult,
  MatchCheck,
  MatchInvoice,
} from "@/lib/sap-match/types";
import { CheckBlock } from "./CheckBlock";
import { inr, qty } from "./format";
import { ItemLinker } from "./ItemLinker";
import { ReceiptCandidatesPanel } from "./ReceiptCandidatesPanel";

type Tone = "ok" | "warn" | "bad" | "wait";

const TONE_TEXT: Record<Tone, string> = {
  ok: "text-[#111827]",
  warn: "text-[#9a5a0a]",
  bad: "text-[#b3261e]",
  wait: "text-[#5c5650]",
};

function toneOf(checks: MatchCheck[], ids: string[]): Tone {
  const relevant = checks.filter(
    (check) => ids.includes(check.id) && check.open,
  );
  if (relevant.some((check) => check.sev === "block")) return "bad";
  if (relevant.some((check) => check.sev === "wait")) return "wait";
  if (relevant.length) return "warn";
  return "ok";
}

function Row({
  label,
  order,
  received,
  billed,
  tone,
  orderNote,
  billedNote,
}: {
  label: string;
  order: string;
  received: string;
  billed: string;
  tone: Tone;
  orderNote?: string;
  billedNote?: string;
}) {
  return (
    <tr className="border-t border-[#f0ece4]">
      <td className="py-2 pr-3 text-[#6b5d50]">{label}</td>
      <td className="py-2 pr-3 tabular-nums text-[#111827]">
        {order}
        {orderNote ? (
          <div className="mt-0.5 text-[9px] text-[#6b5d50]">{orderNote}</div>
        ) : null}
      </td>
      <td className="py-2 pr-3 tabular-nums text-[#111827]">{received}</td>
      <td className={`py-2 tabular-nums font-semibold ${TONE_TEXT[tone]}`}>
        {billed}
        {billedNote ? (
          <div className="mt-0.5 text-[9px] font-normal text-[#6b5d50]">
            {billedNote}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function SourceHeader({
  title,
  reference,
  detail,
}: {
  title: string;
  reference: string;
  detail?: string;
}) {
  return (
    <th scope="col" className="w-[29%] pb-2 pr-3 align-top font-semibold">
      <div className="text-[10px] uppercase tracking-wide">{title}</div>
      <div className="mt-1 text-[9px] font-normal normal-case tracking-normal">
        {reference}
      </div>
      {detail ? (
        <div
          className="mt-0.5 max-w-[210px] truncate text-[9px] font-normal normal-case tracking-normal"
          title={detail}
        >
          {detail}
        </div>
      ) : null}
    </th>
  );
}

export function MatchLineCard({
  caseId,
  invoice,
  line,
  checks,
  locked,
  busy,
  vendorFound,
  onChoose,
  onUndo,
  onAllocate,
  onResetAllocation,
  onLink,
}: {
  caseId: string;
  invoice: MatchInvoice;
  line: LineResult;
  checks: MatchCheck[];
  locked: boolean;
  busy: boolean;
  vendorFound: boolean;
  onChoose: (check: MatchCheck, choice: string, reason: string) => void;
  onUndo: (check: MatchCheck) => void;
  onAllocate: (lineIndex: number, allocations: Record<string, number>) => void;
  onResetAllocation: (lineIndex: number) => void;
  onLink: (line: LineResult, itemCode: string) => void;
}) {
  const invoiceLine = invoice.lines[line.index];
  const service = line.kind === "service";
  const unmapped = line.kind === "unmapped";
  const selected = line.candidates.filter(
    (candidate) => candidate.allocated > 0,
  );
  const received = selected.reduce(
    (total, candidate) => total + candidate.open,
    0,
  );
  const title =
    invoiceLine?.description ||
    invoiceLine?.vendorItemCode ||
    `Line ${line.index + 1}`;
  const mapCheck = checks.find((check) => check.id === `map-${line.index}`);
  const others = checks.filter(
    (check) =>
      check.id !== `map-${line.index}` && (check.open || check.decision),
  );
  const unit = invoiceLine?.unit ?? "";
  const quantity = (value: number | null) =>
    value == null ? "—" : `${qty(value)}${unit ? ` ${unit}` : ""}`;
  const needsReview = checks.some((check) => check.open);
  const hasChecked = checks.some((check) => check.lineIndex === line.index);
  const status = locked
    ? "Saved comparison"
    : unmapped
      ? "Link item"
      : needsReview
        ? "Needs review"
        : hasChecked
          ? "Checks complete"
          : selected.length
            ? "GRPO selected"
            : "Awaiting match";

  const rateDelta =
    !service && line.po?.rate != null && line.invoiceRate != null
      ? line.invoiceRate - line.po.rate
      : null;
  const grpoNumbers = [
    ...new Set(
      selected
        .filter((candidate) => candidate.kind === "GRPO")
        .map((candidate) => candidate.docNum),
    ),
  ];
  const poNumber =
    line.po?.docNum ??
    selected.find((candidate) => candidate.kind === "PO")?.docNum;
  const invoiceSource = [invoice.source?.fileName, invoice.source?.pageLabel]
    .filter(Boolean)
    .join(" · ");
  const grpoRateFallback = line.po?.rateSource === "grpo";
  const grpoRates = [
    ...new Set(
      selected
        .filter(
          (candidate) => candidate.kind === "GRPO" && candidate.price != null,
        )
        .map((candidate) => inr(candidate.price)),
    ),
  ];

  return (
    <section className="overflow-hidden rounded-xl border border-[#e0d8cc] bg-white shadow-[0_1px_2px_rgba(43,26,16,0.04)]">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[#ece6dc] px-4 py-3">
        <div className="min-w-0">
          <div
            className="truncate text-[12px] font-semibold text-[#111827]"
            title={title}
          >
            {title}
          </div>
          <div className="mt-0.5 text-[10px] text-[#6b5d50]">
            {invoiceLine?.vendorItemCode ? (
              <span className="font-mono">{invoiceLine.vendorItemCode}</span>
            ) : null}
            {line.itemCode ? (
              <>
                {invoiceLine?.vendorItemCode ? " → " : ""}
                <span className="font-mono">{line.itemCode}</span>
                {line.itemName ? ` · ${line.itemName}` : ""}
              </>
            ) : null}
            {!unmapped
              ? ` · ${service ? "service, 2-way check" : "stock item, 3-way check"}`
              : ""}
          </div>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${locked || (!needsReview && !unmapped && !hasChecked && !selected.length) ? "bg-[#f0ece4] text-[#6b5d50]" : needsReview || unmapped ? "bg-[#fff0da] text-[#855009]" : "bg-[#e8f3ed] text-[#24583e]"}`}
        >
          {status}
        </span>
      </header>

      <div className="space-y-3 px-4 py-3">
        {unmapped && mapCheck ? (
          <ItemLinker
            caseId={caseId}
            check={mapCheck}
            canLink={vendorFound}
            busy={busy || locked}
            onLink={(itemCode) => onLink(line, itemCode)}
          />
        ) : (
          <>
            <p className="text-[11px] text-[#3d3530]">
              {service
                ? `${inr(line.allocatedQty)} allocated of ${inr(line.invoiceAmount)} billed`
                : `${quantity(line.allocatedQty)} allocated of ${quantity(line.invoiceQty)} billed`}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-[11px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-[#6b5d50]">
                    <th scope="col" className="w-20 pb-1 font-semibold">
                      <span className="sr-only">Field</span>
                    </th>
                    <SourceHeader
                      title="SAP Purchase Order"
                      reference={
                        poNumber != null
                          ? `PO No. ${poNumber}`
                          : "No SAP PO linked"
                      }
                    />
                    <SourceHeader
                      title="SAP Goods Receipt PO (GRPO)"
                      reference={
                        service
                          ? "Not required for services"
                          : grpoNumbers.length
                            ? `GRPO No. ${grpoNumbers.join(", ")}`
                            : "No GRPO selected"
                      }
                    />
                    <SourceHeader
                      title="Scanned Supplier Invoice"
                      reference={`Invoice No. ${invoice.invoiceNumber}`}
                      detail={invoiceSource || undefined}
                    />
                  </tr>
                </thead>
                <tbody>
                  {service ? (
                    <Row
                      label="Amount"
                      order={
                        selected[0] ? `${inr(selected[0].open)} left` : "—"
                      }
                      received="Not needed"
                      billed={inr(line.invoiceAmount)}
                      tone={toneOf(checks, [
                        `amt-${line.index}`,
                        `rcpt-${line.index}`,
                      ])}
                    />
                  ) : (
                    <>
                      <Row
                        label="Quantity"
                        order={quantity(line.po?.qty ?? null)}
                        received={
                          selected.length
                            ? `${quantity(received)} open${selected.length > 1 ? ` (${selected.length} GRPOs)` : ""}`
                            : "Not yet"
                        }
                        billed={quantity(line.invoiceQty)}
                        tone={toneOf(checks, [
                          `qty-${line.index}`,
                          `rcpt-${line.index}`,
                        ])}
                      />
                      <Row
                        label="Unit Price"
                        order={
                          !grpoRateFallback && line.po?.rate != null
                            ? inr(line.po.rate)
                            : "—"
                        }
                        orderNote={
                          grpoRateFallback
                            ? "PO price unavailable"
                            : line.po?.rate != null && !line.po.rateSource
                              ? "Price source not recorded"
                              : undefined
                        }
                        received={grpoRates.join(" / ") || "—"}
                        billed={`${inr(line.invoiceRate)}${rateDelta !== null && Math.abs(rateDelta) > 0.005 ? ` (${rateDelta > 0 ? "+" : "−"}${inr(Math.abs(rateDelta))})` : ""}`}
                        tone={toneOf(checks, [`rate-${line.index}`])}
                        billedNote={
                          grpoRateFallback
                            ? `Compared with GRPO${grpoNumbers[0] != null ? ` No. ${grpoNumbers[0]}` : ""} price`
                            : undefined
                        }
                      />
                      <Row
                        label="Vehicle No."
                        order="—"
                        received={
                          [
                            ...new Set(
                              selected
                                .map((candidate) => candidate.vehicle)
                                .filter(Boolean),
                            ),
                          ].join(", ") || "—"
                        }
                        billed={invoice.vehicles.join(", ") || "—"}
                        billedNote={
                          invoice.vehicles.length
                            ? "From scanned packet"
                            : undefined
                        }
                        tone={toneOf(checks, [`anchor-${line.index}`])}
                      />
                    </>
                  )}
                  <Row
                    label="PO No."
                    order={line.po?.ref ?? "—"}
                    received="—"
                    billed={invoice.poReferences.join(", ") || "—"}
                    billedNote={
                      invoice.poReferences.length
                        ? "From scanned packet"
                        : undefined
                    }
                    tone="ok"
                  />
                </tbody>
              </table>
            </div>

            {others.map((check) => (
              <CheckBlock
                key={check.id}
                check={check}
                locked={locked}
                busy={busy}
                onChoose={(choice, reason) => onChoose(check, choice, reason)}
                onUndo={() => onUndo(check)}
              />
            ))}

            {line.candidates.length ? (
              <ReceiptCandidatesPanel
                caseId={caseId}
                line={line}
                title={title}
                unit={unit}
                locked={locked}
                busy={busy}
                onAllocate={onAllocate}
                onResetAllocation={onResetAllocation}
              />
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
