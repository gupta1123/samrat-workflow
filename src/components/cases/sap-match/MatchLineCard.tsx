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
import { ItemMatchingEvidence } from "./MatchingEvidence";
import { receiptProblems } from "@/lib/sap-match/receipt-problems";
import { ServicePoCandidates } from "./ServicePoCandidates";

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

function Cell({
  value,
  note,
  tone = "ok",
  dim = false,
}: {
  value: string;
  note?: string;
  tone?: Tone;
  dim?: boolean;
}) {
  return (
    <td
      className={`px-3 py-1.5 tabular-nums ${dim ? "text-[#a89c8e]" : TONE_TEXT[tone]} ${tone === "ok" ? "" : "font-semibold"}`}
    >
      {value}
      {note ? (
        <span className="block text-[10px] font-normal text-[#8a7f72]">
          {note}
        </span>
      ) : null}
    </td>
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
  lineCount = 1,
  receiptsOpen,
  onReceiptsOpenChange,
  searchNote,
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
  /** How many lines the invoice has; the card only labels itself when there are several. */
  lineCount?: number;
  /** Controlled state of the receipts drawer, so the Receipts tile can open it. */
  receiptsOpen?: boolean;
  onReceiptsOpenChange?: (open: boolean) => void;
  searchNote?: string | null;
  onChoose: (check: MatchCheck, choice: string, reason: string) => void;
  onUndo: (check: MatchCheck) => void;
  onAllocate: (lineIndex: number, allocations: Record<string, number>) => void;
  onResetAllocation: (lineIndex: number) => void;
  onLink: (line: LineResult, itemCode: string) => void;
}) {
  const invoiceLine = invoice.lines[line.index];
  const service = line.kind === "service" || line.kind === "non-stock";
  const nonStock = line.kind === "non-stock";
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
  const problems = receiptProblems(invoice, line);

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
  const sameAsTitle =
    (line.itemName ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "") ===
    title.toUpperCase().replace(/[^A-Z0-9]/g, "");
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

  const header = (label: string, reference: string) => (
    <th scope="col" className="px-3 py-1.5 text-left font-semibold">
      <span className="block text-[10px] font-medium uppercase tracking-wider text-[#8a7f72]">
        {label}
      </span>
      <span className="block text-[11px] font-medium text-[#111827]">
        {reference}
      </span>
    </th>
  );
  const rowLabel = (text: string) => (
    <th
      scope="row"
      className="px-3 py-1.5 text-left font-normal text-[#6b5d50]"
    >
      {text}
    </th>
  );
  const poLabel = poNumber != null ? `PO ${poNumber}` : "No PO linked";
  const grpoLabel = grpoNumbers.length
    ? `${grpoNumbers.length} GRPO${grpoNumbers.length === 1 ? "" : "s"}`
    : "No GRPO";

  return (
    <section className="overflow-hidden rounded-xl border border-[#e0d8cc] bg-white shadow-[0_1px_2px_rgba(43,26,16,0.04)]">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-[#ece6dc] px-4 py-2.5">
        <div className="min-w-0">
          <div
            className="truncate text-[12px] font-semibold text-[#111827]"
            title={title}
          >
            {title}
          </div>
          {line.itemCode ? (
            <div className="text-[10px] text-[#6b5d50]">
              {invoiceLine?.vendorItemCode ? (
                <span className="font-mono">{invoiceLine.vendorItemCode}</span>
              ) : null}
              {invoiceLine?.vendorItemCode ? " → " : ""}
              <span className="font-mono">{line.itemCode}</span>
              {line.itemName && !sameAsTitle ? ` · ${line.itemName}` : ""}
              {` · ${nonStock ? "non-stock item, invoice-to-PO check" : service ? "service, 2-way check" : "stock item, 3-way check"}`}
            </div>
          ) : null}
          {service && !line.itemCode ? (
            <p className="text-[10px] text-[#6b5d50]">
              Service · Invoice-to-PO check ·{" "}
              {line.po?.accountCode
                ? `SAP account ${line.po.accountCode}`
                : "No stock item required"}
            </p>
          ) : null}
        </div>
        {lineCount > 1 ? (
          <span className="text-[10px] text-[#8a7f72]">
            Line {line.index + 1} of {lineCount}
          </span>
        ) : null}
      </header>

      <div className="space-y-2.5 px-4 py-3">
        {service && invoice.servicePeriod ? (
          <p className="text-[11px]">Service period: {invoice.servicePeriod}</p>
        ) : null}
        {unmapped || (service && line.itemCode) ? (
          <ItemMatchingEvidence invoice={invoice} line={line} />
        ) : null}
        {unmapped && mapCheck ? (
          <>
            <ItemLinker
              caseId={caseId}
              check={mapCheck}
              canLink={vendorFound}
              busy={busy || locked}
              onLink={(itemCode) => onLink(line, itemCode)}
            />
            {line.nonStockPoCandidates?.length ? (
              <section className="rounded-lg border border-[#f0d7a6] bg-[#fdfaf3] p-3">
                <h3 className="mb-2 text-[12px] font-semibold">
                  Found on this supplier’s purchase orders · confirmation
                  required
                </h3>
                <p className="mb-2 text-[11px] text-[#6b5d50]">
                  These are the supplier’s SAP-confirmed non-stock PO lines, not
                  automatic product matches. Keep the stock-item flow above if
                  these do not describe this purchase.
                </p>
                <ServicePoCandidates
                  line={{
                    ...line,
                    kind: "non-stock",
                    candidates: line.nonStockPoCandidates,
                  }}
                  invoiceLine={invoiceLine}
                  invoicePoReferences={invoice.poReferences}
                  disabled={busy || locked}
                  onAllocate={onAllocate}
                  onReset={onResetAllocation}
                />
              </section>
            ) : null}
          </>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[320px] text-[11px]">
                <thead>
                  <tr className="border-b border-[#ece6dc]">
                    <th scope="col" className="w-20 px-3 py-1.5">
                      <span className="sr-only">Field</span>
                    </th>
                    {header("SAP purchase order", poLabel)}
                    {!service
                      ? header(
                          locked ? "SAP GRPO at saved check" : "SAP GRPO",
                          grpoLabel,
                        )
                      : null}
                    {header(
                      "Scanned invoice",
                      [
                        invoiceLine?.source?.fileName ??
                          invoice.source?.fileName,
                        invoiceLine?.source?.pageLabel ??
                          invoice.source?.pageLabel ??
                          "PDF",
                      ]
                        .filter(Boolean)
                        .join(" · "),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {service ? (
                    <>
                      <tr className="border-t border-[#f0ece4]">
                        {rowLabel("Amount")}
                        <Cell
                          value={
                            selected[0] ? `${inr(selected[0].open)} left` : "—"
                          }
                          dim={!selected[0]}
                        />
                        <Cell
                          value={inr(line.invoiceAmount)}
                          tone={toneOf(checks, [
                            `amt-${line.index}`,
                            `rcpt-${line.index}`,
                          ])}
                        />
                      </tr>
                      {line.itemCode && line.invoiceQty != null ? (
                        <tr className="border-t border-[#f0ece4]">
                          {rowLabel(nonStock ? "Quantity" : "Billing units")}
                          <Cell
                            value={
                              line.po?.qty != null
                                ? `${qty(line.po.qty)} ${unit}`
                                : "—"
                            }
                            note="Ordered"
                          />
                          <Cell
                            value={`${qty(line.invoiceQty)} ${unit}`}
                            tone={toneOf(checks, [`qty-${line.index}`])}
                          />
                        </tr>
                      ) : null}
                      {line.itemCode && line.invoiceRate != null ? (
                        <tr className="border-t border-[#f0ece4]">
                          {rowLabel("Unit price")}
                          <Cell value={inr(line.po?.rate ?? null)} />
                          <Cell
                            value={inr(line.invoiceRate)}
                            tone={toneOf(checks, [`rate-${line.index}`])}
                          />
                        </tr>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <tr className="border-t border-[#f0ece4]">
                        {rowLabel("Quantity")}
                        <Cell
                          value={quantity(line.po?.qty ?? null)}
                          note={line.po?.qty != null ? "Ordered" : undefined}
                          dim={line.po?.qty == null}
                        />
                        <Cell
                          value={
                            selected.length ? quantity(balances.available) : "—"
                          }
                          note={
                            selected.length ? "Received, not billed" : undefined
                          }
                          dim={!selected.length}
                        />
                        <Cell
                          value={quantity(line.invoiceQty)}
                          note="Billed"
                          tone={toneOf(checks, [
                            `qty-${line.index}`,
                            `rcpt-${line.index}`,
                          ])}
                        />
                      </tr>
                      <tr className="border-t border-[#f0ece4]">
                        {rowLabel("Unit price")}
                        <Cell
                          value={
                            !grpoRateFallback && line.po?.rate != null
                              ? inr(line.po.rate)
                              : "—"
                          }
                          note={
                            grpoRateFallback
                              ? "PO price unavailable"
                              : line.po?.rate != null && !line.po.rateSource
                                ? "Price source not recorded"
                                : undefined
                          }
                          dim={grpoRateFallback || line.po?.rate == null}
                        />
                        <Cell
                          value={grpoRates.join(" / ") || "—"}
                          dim={!grpoRates.length}
                        />
                        <Cell
                          value={invoicePrice}
                          tone={toneOf(checks, [`rate-${line.index}`])}
                          note={
                            grpoRateFallback
                              ? `Compared with GRPO${grpoNumbers[0] != null ? ` ${grpoNumbers[0]}` : ""} price`
                              : undefined
                          }
                        />
                      </tr>
                      <tr className="border-t border-[#f0ece4]">
                        {rowLabel("Line total")}
                        <Cell
                          value={
                            !grpoRateFallback &&
                            line.po?.rate != null &&
                            line.invoiceQty != null
                              ? inr(line.po.rate * line.invoiceQty)
                              : "—"
                          }
                          dim={grpoRateFallback || line.po?.rate == null}
                        />
                        <Cell value="—" dim />
                        <Cell
                          value={inr(
                            line.invoiceAmount ?? invoiceLine?.amount ?? null,
                          )}
                        />
                      </tr>
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

            {others
              .filter((check) => !locked || check.decision)
              .map((check) => (
                <CheckBlock
                  key={check.id}
                  check={check}
                  locked={locked}
                  busy={busy}
                  priceReview={
                    !locked && check.id === `rate-${line.index}`
                      ? priceReviewDetails(invoice, line, rateTolerancePct)
                      : undefined
                  }
                  onChoose={(choice, reason) => onChoose(check, choice, reason)}
                  onUndo={() => onUndo(check)}
                />
              ))}

            {!service && problems.ignoredPo?.length ? (
              <p className="text-[11px] text-[#6b5d50]">
                The invoice prints {problems.ignoredPo.join(", ")}, not a SAP PO
                number, so the PO is not compared.
              </p>
            ) : null}

            {!service && (problems.rows.length || problems.missingNote) ? (
              <ul className="space-y-1" aria-label="Receipt reference problems">
                {problems.rows.map((row) => (
                  <li
                    key={row}
                    className="flex items-start gap-2 text-[11px] text-[#b3261e]"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#fbe7e5] text-[10px] font-bold"
                    >
                      ✕
                    </span>
                    {row}
                  </li>
                ))}
                {problems.missingNote ? (
                  <li className="text-[11px] text-[#6b5d50]">
                    {problems.missingNote}
                  </li>
                ) : null}
              </ul>
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-2">
              {line.candidates.length ? (
                service ? (
                  <ServicePoCandidates
                    line={line}
                    invoiceLine={invoiceLine}
                    invoicePoReferences={invoice.poReferences}
                    disabled={busy || locked}
                    onAllocate={onAllocate}
                    onReset={onResetAllocation}
                  />
                ) : (
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
                    open={receiptsOpen}
                    onOpenChange={onReceiptsOpenChange}
                    searchNote={searchNote}
                  />
                )
              ) : null}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
