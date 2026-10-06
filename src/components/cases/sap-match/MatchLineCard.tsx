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
import { priceReviewDetails } from "@/lib/sap-match/price-review";
import { quantityBalances } from "@/lib/sap-match/evidence";
import { ItemMatchingEvidence, MatchingEvidence } from "./MatchingEvidence";
import { SupplierOrdersPanel } from "./SupplierOrdersPanel";

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
  receivedNote,
  hideReceipt = false,
}: {
  label: string;
  order: string;
  received: string;
  billed: string;
  tone: Tone;
  orderNote?: string;
  billedNote?: string;
  receivedNote?: string;
  hideReceipt?: boolean;
}) {
  return (
    <tr className="border-t border-[#f0ece4]">
      <td className="py-2 pr-3 text-[#6b5d50]">{label}</td>
      <td className="py-2 pr-3 tabular-nums text-[#111827]">
        {order}
        {orderNote ? (
          <div className="mt-0.5 text-[11px] text-[#6b5d50]">{orderNote}</div>
        ) : null}
      </td>
      {!hideReceipt ? (
        <td className="py-2 pr-3 tabular-nums text-[#111827]">
          {received}
          {receivedNote ? (
            <div className="mt-0.5 text-[10px] text-[#6b5d50]">
              {receivedNote}
            </div>
          ) : null}
        </td>
      ) : null}
      <td className={`py-2 tabular-nums font-semibold ${TONE_TEXT[tone]}`}>
        {billed}
        {billedNote ? (
          <div className="mt-0.5 text-[11px] font-normal text-[#6b5d50]">
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
      <div className="text-[11px]">{title}</div>
      <div className="mt-1 text-[11px] font-normal normal-case tracking-normal">
        {reference}
      </div>
      {detail ? (
        <div
          className="mt-0.5 max-w-[210px] truncate text-[11px] font-normal normal-case tracking-normal"
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
  rateTolerancePct,
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
  rateTolerancePct?: number;
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
  const balances = quantityBalances(line);
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
  const unchecked = checks.filter((check) => check.sev === "unchecked");
  const status = locked
    ? "At draft creation"
    : unmapped
      ? "Link item"
      : needsReview
        ? "Needs review"
        : hasChecked
          ? unchecked.length
            ? "Checks incomplete"
            : checks.some((check) => check.decision)
              ? "Reviewed"
              : "Matched"
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
  const invoicePrice = `${inr(line.invoiceRate)}${rateDelta !== null && Math.abs(rateDelta) > 0.005 ? ` (${rateDelta > 0 ? "+" : "−"}${inr(Math.abs(rateDelta))})` : ""}`;

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
        <ItemMatchingEvidence invoice={invoice} line={line} />
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
            <div className="sm:hidden">
              <table className="w-full table-fixed text-left text-[11px]">
                <thead className="text-[#6b5d50]">
                  <tr>
                    <th scope="col" className="w-[22%] pb-2 font-medium">
                      <span className="sr-only">Field</span>
                    </th>
                    <th
                      scope="col"
                      className="w-[39%] pb-2 pr-2 align-top font-semibold text-[#111827]"
                    >
                      Scanned Invoice (PDF)
                    </th>
                    <th
                      scope="col"
                      className="pb-2 align-top font-semibold text-[#111827]"
                    >
                      SAP
                    </th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  <tr className="border-t border-[#f0ece4] align-top">
                    <th
                      scope="row"
                      className="py-2 pr-2 font-normal text-[#6b5d50]"
                    >
                      {service ? "Amount" : "Quantity"}
                    </th>
                    <td
                      className={`py-2 pr-2 font-semibold ${TONE_TEXT[toneOf(checks, [service ? `amt-${line.index}` : `qty-${line.index}`, `rcpt-${line.index}`])]}`}
                    >
                      {service
                        ? inr(line.invoiceAmount)
                        : quantity(line.invoiceQty)}
                    </td>
                    <td className="py-2 text-[#111827]">
                      {selected.length
                        ? service
                          ? inr(selected[0].open)
                          : quantity(balances.available)
                        : "No selection"}
                      <span className="mt-0.5 block text-[#6b5d50]">
                        {service
                          ? "PO Open Amount"
                          : locked
                            ? "GRPO Open Qty. at saved check"
                            : "GRPO Open Qty."}
                      </span>
                    </td>
                  </tr>
                  {!service ? (
                    <tr className="border-t border-[#f0ece4] align-top">
                      <th
                        scope="row"
                        className="py-2 pr-2 font-normal text-[#6b5d50]"
                      >
                        Unit Price
                      </th>
                      <td
                        className={`py-2 pr-2 font-semibold ${TONE_TEXT[toneOf(checks, [`rate-${line.index}`])]}`}
                      >
                        {invoicePrice}
                      </td>
                      <td className="py-2 text-[#111827]">
                        {inr(line.po?.rate ?? null)}
                        <span className="mt-0.5 block text-[#6b5d50]">
                          {grpoRateFallback
                            ? "GRPO price; PO price unavailable"
                            : line.po?.rateSource === "po"
                              ? "PO Unit Price"
                              : "Price source not recorded"}
                        </span>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              <p className="mt-1 text-[11px] text-[#6b5d50]">
                {poNumber != null ? `SAP PO ${poNumber}` : "No SAP PO linked"}
                {!service
                  ? grpoNumbers.length
                    ? ` · GRPO ${grpoNumbers.join(", ")}`
                    : " · No GRPO selected"
                  : " · Service; GRPO not required"}
              </p>
            </div>
            <div className="hidden overflow-x-auto sm:block">
              <table
                className={`w-full ${service ? "min-w-[360px]" : "min-w-[460px]"} text-[11px]`}
              >
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
                    {!service ? (
                      <SourceHeader
                        title={locked ? "SAP GRPO at saved check" : "SAP GRPO"}
                        reference={
                          service
                            ? "Not required for services"
                            : grpoNumbers.length
                              ? `GRPO No. ${grpoNumbers.join(", ")}`
                              : "No GRPO selected"
                        }
                      />
                    ) : null}
                    <SourceHeader
                      title="Scanned Invoice (PDF)"
                      reference={
                        invoice.source?.pageLabel ?? "Supplier invoice"
                      }
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
                      hideReceipt
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
                            ? `${quantity(balances.available)} open`
                            : "No selection"
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
                        billed={invoicePrice}
                        tone={toneOf(checks, [`rate-${line.index}`])}
                        billedNote={
                          grpoRateFallback
                            ? `Compared with GRPO${grpoNumbers[0] != null ? ` No. ${grpoNumbers[0]}` : ""} price`
                            : undefined
                        }
                      />
                    </>
                  )}
                </tbody>
              </table>
            </div>

            {!service &&
            selected.length &&
            !checks.some(
              (check) =>
                check.open &&
                (check.id === `qty-${line.index}` ||
                  check.id.startsWith(`part-${line.index}-`)),
            ) &&
            (balances.remaining > 0.0005 ||
              Math.abs(balances.used - (line.invoiceQty ?? 0)) > 0.0005) ? (
              <p className="text-[11px] text-[#6b5d50]">
                {locked ? "Used in draft" : "Allocated"}:{" "}
                {quantity(balances.used)} ·{" "}
                {locked
                  ? "Remaining at saved check"
                  : "Remaining GRPO Open Qty."}
                : {quantity(balances.remaining)}
              </p>
            ) : null}

            {!locked
              ? others.map((check) => (
                  <CheckBlock
                    key={check.id}
                    check={check}
                    locked={locked}
                    busy={busy}
                    priceReview={
                      check.id === `rate-${line.index}`
                        ? priceReviewDetails(invoice, line, rateTolerancePct)
                        : undefined
                    }
                    onChoose={(choice, reason) =>
                      onChoose(check, choice, reason)
                    }
                    onUndo={() => onUndo(check)}
                  />
                ))
              : others
                  .filter((check) => check.decision)
                  .map((check) => (
                    <CheckBlock
                      key={check.id}
                      check={check}
                      locked
                      busy={busy}
                      onChoose={() => {}}
                      onUndo={() => {}}
                    />
                  ))}

            {unchecked.length ? (
              <p className="text-[11px] text-[#6b5d50]">
                Not checked: {unchecked.map((check) => check.title).join("; ")}
              </p>
            ) : null}

            <MatchingEvidence invoice={invoice} line={line} locked={locked} />

            <div className="flex flex-wrap gap-2">
              {line.candidates.length ? (
                <ReceiptCandidatesPanel
                  caseId={caseId}
                  invoice={invoice}
                  line={line}
                  title={title}
                  unit={unit}
                  locked={locked}
                  busy={busy}
                  onAllocate={onAllocate}
                  onResetAllocation={onResetAllocation}
                />
              ) : null}
              {vendorFound && line.kind === "material" ? (
                <SupplierOrdersPanel
                  caseId={caseId}
                  line={line}
                  invoiceNumber={invoice.invoiceNumber}
                />
              ) : null}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
