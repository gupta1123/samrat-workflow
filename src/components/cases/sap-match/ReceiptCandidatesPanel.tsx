"use client";

import { useId, useState } from "react";
import { Content as DialogContent } from "@radix-ui/react-dialog";
import {
  Check,
  ChevronRight,
  Loader2,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { receiptSelection } from "@/lib/sap-match/receipt-selection";
import {
  poNotOnInvoice,
  rankCandidates,
  type RankedCandidate,
} from "@/lib/sap-match/candidate-ranking";
import { SAP_TERMS } from "@/lib/sap-match/terminology";
import type { LineResult, MatchInvoice } from "@/lib/sap-match/types";
import { formatDate, inr, qty } from "./format";
import { CandidateEvidence } from "./MatchingEvidence";

function Signals({ ranked }: { ranked: RankedCandidate }) {
  if (!ranked.signals.length) return null;
  return (
    <ul className="mt-1 flex flex-wrap gap-1" aria-label="Reference checks">
      {ranked.signals.map((signal) => (
        <li
          key={signal.label}
          title={signal.note ?? `SAP: ${signal.sap}`}
          className={`rounded px-1.5 py-0.5 text-[10px] leading-3 ${signal.status === "same" ? "bg-[#e3f1e8] text-[#24583e]" : "bg-[#fbeceb] text-[#9b2923]"}`}
        >
          {signal.status === "same" ? "✓" : "≠"} {signal.label}
          {signal.status === "different" ? ` ${signal.sap}` : ""}
        </li>
      ))}
    </ul>
  );
}

function CandidateCard({
  ranked,
  invoice,
  service,
  unit,
  value,
  error,
  locked,
  busy,
  group,
  showLine,
  fillValue,
  onValue,
}: {
  ranked: RankedCandidate;
  invoice: MatchInvoice;
  service: boolean;
  unit: string;
  value: string;
  error?: string;
  locked: boolean;
  busy: boolean;
  group: string;
  showLine: boolean;
  fillValue: number;
  onValue: (next: string) => void;
}) {
  const { candidate } = ranked;
  const id = useId();
  const chosen = Number(value) > 0;
  const rejected = Boolean(candidate.rejected);
  const amount = (value: number) =>
    service ? inr(value) : `${qty(value)}${unit ? ` ${unit}` : ""}`;
  return (
    <li
      className={`rounded-md border px-3 py-2 ${rejected ? "border-[#e0d8cc] bg-[#f6f3ee]" : chosen ? "border-[#8bb59b] bg-[#f3f9f5]" : "border-[#e0d8cc] bg-white"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <h4 className="text-[11px] font-semibold text-[#111827]">
              {service ? "PO" : SAP_TERMS.grpo} {candidate.docNum}
              {showLine ? (
                <span className="ml-1.5 text-[10px] font-normal text-[#6b5d50]">
                  Line {candidate.lineNum + 1}
                </span>
              ) : null}
            </h4>
            {chosen && !rejected ? (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-[#dfefe4] px-1.5 py-0.5 text-[9px] font-medium text-[#24583e]">
                <Check className="h-2.5 w-2.5" />
                Selected
              </span>
            ) : null}
            {ranked.otherInvoice && !rejected ? (
              <span className="rounded-full bg-[#fbeceb] px-1.5 py-0.5 text-[9px] font-medium text-[#9b2923]">
                Stores tagged invoice {ranked.otherInvoice}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-[10px] leading-4 text-[#6b5d50]">
            {[
              formatDate(candidate.date),
              candidate.poRef ? `PO ${candidate.poRef}` : null,
              candidate.vehicle,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {rejected ? (
            <p className="mt-1 text-[10px] leading-4 text-[#9b2923]">
              Excluded: {candidate.rejected}
            </p>
          ) : (
            <>
              <Signals ranked={ranked} />
              {error ? (
                <p
                  id={`${id}-error`}
                  className="mt-1 text-[10px] leading-4 text-[#b3261e]"
                >
                  {error}
                </p>
              ) : null}
              {ranked.otherWarnings.length ? (
                <p className="mt-1 text-[10px] leading-4 text-[#855009]">
                  {ranked.otherWarnings.join("; ")}
                </p>
              ) : null}
            </>
          )}
        </div>
        {!rejected ? (
          <div className="shrink-0 text-right">
            <p className="whitespace-nowrap text-[10px] leading-4 text-[#6b5d50]">
              <span
                title={
                  locked
                    ? "Open balance at the saved check"
                    : "Open balance available for this invoice"
                }
              >
                {service ? SAP_TERMS.openAmount : SAP_TERMS.openQty}
              </span>
              {locked ? " (saved)" : ""}:{" "}
              <span className="font-semibold tabular-nums text-[#111827]">
                {amount(candidate.open)}
              </span>
            </p>
            {locked ? (
              <p className="mt-1 text-[11px] text-[#3d3530]">
                Used:{" "}
                <span className="font-semibold tabular-nums">
                  {amount(candidate.allocated)}
                </span>
              </p>
            ) : service ? (
              <label className="mt-1 flex h-7 cursor-pointer items-center justify-end gap-1.5 text-[11px] font-medium text-[#24583e]">
                <input
                  className="h-3 w-3 accent-[#2d6a4f]"
                  type="radio"
                  name={group}
                  checked={chosen}
                  disabled={busy}
                  aria-label={`Use purchase order ${candidate.docNum}, line ${candidate.lineNum + 1}`}
                  onChange={() => onValue("use")}
                />
                Use this PO
              </label>
            ) : (
              <div className="mt-1 flex items-center justify-end gap-1">
                {!chosen && fillValue > 0 ? (
                  <button
                    type="button"
                    className="h-7 rounded-md border border-[#b6aca0] bg-white px-2 text-[10px] font-medium text-[#24583e] hover:bg-[#f3f9f5] disabled:opacity-50"
                    disabled={busy}
                    title={`Allocate ${amount(fillValue)} from this GRPO`}
                    onClick={() => onValue(String(fillValue))}
                  >
                    Use {qty(fillValue)}
                  </button>
                ) : null}
                <input
                  id={id}
                  aria-label={`Quantity from GRPO ${candidate.docNum}, line ${candidate.lineNum + 1}${unit ? ` (${unit})` : ""}`}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? `${id}-error` : undefined}
                  placeholder="0"
                  className={`h-7 w-20 rounded-md border bg-white px-2 text-right text-[11px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-[#2d6a4f] disabled:opacity-50 ${error ? "border-[#b3261e]" : "border-[#b6aca0]"}`}
                  inputMode="decimal"
                  disabled={busy}
                  value={value}
                  onChange={(event) => onValue(event.target.value)}
                />
              </div>
            )}
          </div>
        ) : null}
      </div>
      {!rejected ? (
        <details className="mt-0.5 text-[10px] text-[#6b5d50]">
          <summary className="cursor-pointer leading-4 font-medium">
            Matching details
          </summary>
          <div className="mt-1 space-y-0.5 border-t border-[#e0d8cc] pt-1 leading-4">
            {!service ? (
              <p>Received Qty.: {amount(candidate.quantity)}</p>
            ) : null}
            <CandidateEvidence
              invoice={invoice}
              candidate={candidate}
              compact
            />
            {candidate.note &&
            !/^Based On Purchase Orders\b/i.test(candidate.note.trim()) ? (
              <p>{candidate.note}</p>
            ) : null}
          </div>
        </details>
      ) : null}
    </li>
  );
}

export function ReceiptCandidatesPanel({
  caseId,
  invoice,
  line,
  title,
  unit,
  locked,
  busy,
  onAllocate,
  onResetAllocation,
}: {
  caseId: string;
  invoice: MatchInvoice;
  line: LineResult;
  title: string;
  unit: string;
  locked: boolean;
  busy: boolean;
  onAllocate: (index: number, allocations: Record<string, number>) => void;
  onResetAllocation: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const service = line.kind === "service";
  const label = service ? "POs" : SAP_TERMS.grpos;
  const selection = receiptSelection(line, locked ? {} : edits);
  const format = (value: number | null) =>
    value == null
      ? "—"
      : service
        ? inr(value)
        : `${qty(value)}${unit ? ` ${unit}` : ""}`;
  const hasErrors = Object.keys(selection.errors).length > 0;
  const matched =
    selection.remaining != null && Math.abs(selection.remaining) < 0.000001;
  const overPo =
    service &&
    line.candidates.some(
      (candidate) =>
        (selection.allocations[candidate.key] ?? 0) > candidate.open + 0.5,
    );
  const ignorePo = !service && poNotOnInvoice(invoice, line.candidates);
  const ranked = rankCandidates(invoice, line.candidates, ignorePo);
  const lineCount = new Map<number, number>();
  for (const candidate of line.candidates)
    lineCount.set(candidate.docNum, (lineCount.get(candidate.docNum) ?? 0) + 1);
  const query = search.trim().toLowerCase();
  const matches = ({ candidate }: RankedCandidate) =>
    [
      candidate.docNum,
      candidate.poRef,
      candidate.vehicle,
      candidate.date,
      candidate.rejected,
      candidate.references?.invoice,
      candidate.references?.eWayBill,
      candidate.references?.lorryReceipt,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  // Keep groups stable while typing so editing never moves a focused input.
  const selected = ranked.filter(
    ({ candidate }) => !candidate.rejected && candidate.allocated > 0,
  );
  const eligible = ranked.filter(
    ({ candidate }) => !candidate.rejected && candidate.allocated <= 0,
  );
  const likely = eligible.filter((entry) => entry.same > 0);
  const others = eligible.filter((entry) => entry.same === 0);
  const excluded = ranked.filter(({ candidate }) => candidate.rejected);
  const remaining = Math.max(0, selection.remaining ?? 0);
  const valueOf = (key: string, allocated: number) =>
    edits[key] ?? (allocated > 0 ? String(allocated) : "");
  const renderCandidates = (entries: RankedCandidate[]) => (
    <ul className="space-y-1.5">
      {entries.filter(matches).map((entry) => {
        const { candidate } = entry;
        const value = valueOf(candidate.key, candidate.allocated);
        return (
          <CandidateCard
            key={candidate.key}
            ranked={entry}
            invoice={invoice}
            service={service}
            unit={unit}
            value={value}
            error={selection.errors[candidate.key]}
            locked={locked}
            busy={busy}
            group={`service-order-${caseId}-${line.index}`}
            showLine={(lineCount.get(candidate.docNum) ?? 0) > 1}
            fillValue={
              Math.round(Math.min(candidate.open, remaining) * 1000) / 1000
            }
            onValue={(next) => {
              if (service) {
                setEdits(
                  Object.fromEntries(
                    line.candidates
                      .filter((candidate) => !candidate.rejected)
                      .map((option) => [
                        option.key,
                        option.key === candidate.key
                          ? String(line.invoiceAmount ?? 0)
                          : "0",
                      ]),
                  ),
                );
              } else
                setEdits((current) => ({ ...current, [candidate.key]: next }));
            }}
          />
        );
      })}
    </ul>
  );
  const groupTitle = (name: string, entries: RankedCandidate[]) => (
    <h3 className="mb-2 text-[11px] font-semibold text-[#3d3530]">
      {name} ({query ? `${entries.filter(matches).length} of ` : ""}
      {entries.length})
    </h3>
  );
  const invoiceRefs = [
    invoice.vehicles.length ? `Vehicle ${invoice.vehicles.join(", ")}` : null,
    invoice.eWayBill ? `E-way bill ${invoice.eWayBill}` : null,
    invoice.lorryReceipt ? `LR ${invoice.lorryReceipt}` : null,
    invoice.invoiceDate ? formatDate(invoice.invoiceDate) : null,
  ].filter(Boolean);
  const statusText = locked
    ? "Read-only · balances and quantities from the saved comparison, not current SAP balances."
    : hasErrors
      ? "Correct the highlighted quantities before applying."
      : overPo
        ? "This bill exceeds the PO balance. Applying will require review."
        : selection.remaining == null
          ? `Vendor Invoice ${service ? "amount" : "quantity"} is unavailable. Review the invoice.`
          : selection.remaining < 0
            ? `${format(-selection.remaining)} above Invoice ${service ? "Amount" : "Qty."}. Applying will require review.`
            : !matched
              ? `${format(selection.remaining)} still to allocate.`
              : selection.dirty
                ? "Balanced. Apply to save this selection."
                : "Balanced. No changes to apply.";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#d4c9bc] bg-[#fcfbf9] px-2.5 py-1 text-[11px] font-medium text-[#5d422e] hover:bg-[#f0ece4] focus-visible:outline-2 focus-visible:outline-[#2d6a4f]"
        >
          {label} considered ({line.candidates.length})
          <ChevronRight className="h-3 w-3" />
        </button>
      </DialogTrigger>
      <DialogPortal>
        <DialogOverlay className="bg-slate-950/25 backdrop-blur-none" />
        <DialogContent className="fixed inset-y-0 right-0 z-50 flex h-dvh w-full max-w-[560px] flex-col border-l border-[#e0d8cc] bg-[#faf8f4] shadow-2xl outline-none duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right motion-reduce:animate-none">
          <header className="shrink-0 border-b border-[#e0d8cc] bg-white px-4 py-3">
            <DialogTitle className="pr-9 text-[13px] font-semibold text-[#111827]">
              {label} considered ({line.candidates.length})
            </DialogTitle>
            <DialogDescription className="mt-0.5 pr-8 text-[11px] leading-4 text-[#6b5d50]">
              Invoice line {line.index + 1} · {title}
              {line.itemCode ? ` · ${line.itemCode}` : ""}
            </DialogDescription>
            <DialogClose className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full text-[#6b5d50] hover:bg-[#f0ece4] focus-visible:outline-2 focus-visible:outline-[#2d6a4f]">
              <X className="h-3.5 w-3.5" />
              <span className="sr-only">Close {label} considered</span>
            </DialogClose>
            {!service && invoiceRefs.length ? (
              <p className="mt-1.5 text-[11px] leading-4 text-[#3d3530]">
                <span className="text-[#6b5d50]">This invoice: </span>
                {invoiceRefs.join(" · ")}
              </p>
            ) : null}
            {ignorePo ? (
              <p className="mt-1 text-[10px] leading-4 text-[#6b5d50]">
                The invoice prints{" "}
                {invoice.poReferences.length
                  ? invoice.poReferences.join(", ")
                  : "no PO reference"}
                , not a SAP PO number, so PO is not used to rank{" "}
                {label}.
              </p>
            ) : null}
            <dl className="mt-2 grid grid-cols-3 gap-2 rounded-md bg-[#f6f3ee] px-2.5 py-2">
              {[
                {
                  label: service
                    ? SAP_TERMS.invoiceAmount
                    : SAP_TERMS.invoiceQty,
                  value: selection.billed,
                },
                {
                  label: `${service ? "Allocated Amount" : SAP_TERMS.allocatedQty}${selection.dirty ? " (edited)" : ""}`,
                  value: selection.total,
                },
                {
                  label:
                    selection.remaining != null && selection.remaining < 0
                      ? service
                        ? "Excess Amount"
                        : "Excess Qty."
                      : service
                        ? "Unallocated Amount"
                        : "Unallocated Qty.",
                  value:
                    selection.remaining == null
                      ? null
                      : Math.abs(selection.remaining),
                },
              ].map((entry) => (
                <div key={entry.label}>
                  <dt className="text-[10px] text-[#6b5d50]">{entry.label}</dt>
                  <dd className="mt-0.5 break-words text-[12px] font-semibold tabular-nums text-[#111827]">
                    {format(entry.value)}
                  </dd>
                </div>
              ))}
            </dl>
            {line.candidates.length > 6 ? (
              <div className="relative mt-2">
                <Search className="pointer-events-none absolute left-2.5 top-2 h-3 w-3 text-[#6b5d50]" />
                <input
                  aria-label={`Search considered ${label}`}
                  placeholder={
                    service
                      ? "Filter by PO No. or Posting Date"
                      : "Filter by GRPO, PO, vehicle, e-way bill, LR or invoice No."
                  }
                  className="h-7 w-full rounded-md border border-[#d4c9bc] bg-white pl-7 pr-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-[#2d6a4f]"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            ) : null}
          </header>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3">
            {selected.filter(matches).length ? (
              <section>
                {line.candidates.length > 1 || selection.dirty
                  ? groupTitle(
                      selection.dirty ? "Currently applied" : "Selected",
                      selected,
                    )
                  : null}
                {renderCandidates(selected)}
              </section>
            ) : null}
            {likely.filter(matches).length ? (
              <section>
                {groupTitle(
                  service
                    ? "Other eligible POs"
                    : "Likely matches · at least one reference agrees",
                  likely,
                )}
                {renderCandidates(likely)}
              </section>
            ) : null}
            {!selected.filter(matches).length &&
            !eligible.filter(matches).length ? (
              <p className="text-[11px] text-[#6b5d50]">
                {query
                  ? "No eligible candidates match your search."
                  : "No eligible candidates available."}
              </p>
            ) : null}
            {others.filter(matches).length ? (
              <details
                key={query ? "searching-others" : "others"}
                open={query || !likely.length ? true : undefined}
                className="border-t border-[#e0d8cc] pt-2"
              >
                <summary className="min-h-7 cursor-pointer text-[11px] font-semibold text-[#6b5d50]">
                  {service
                    ? "Other eligible POs"
                    : "Same supplier and item, no matching reference"}{" "}
                  ({query ? `${others.filter(matches).length} of ` : ""}
                  {others.length})
                </summary>
                <div className="mt-1.5">{renderCandidates(others)}</div>
              </details>
            ) : null}
            {excluded.filter(matches).length ? (
              <details
                key={query ? "searching" : "all"}
                open={query ? true : undefined}
                className="border-t border-[#e0d8cc] pt-2"
              >
                <summary className="min-h-7 cursor-pointer text-[11px] font-semibold text-[#6b5d50]">
                  Excluded {label} ({excluded.filter(matches).length})
                </summary>
                <div className="mt-1.5">{renderCandidates(excluded)}</div>
              </details>
            ) : null}
          </div>
          <footer className="shrink-0 border-t border-[#e0d8cc] bg-white px-4 py-2.5">
            <p
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className={`text-[11px] leading-4 ${locked ? "text-[#6b5d50]" : hasErrors || !matched || overPo ? "text-[#855009]" : "text-[#24583e]"}`}
            >
              {!locked && selection.remaining != null ? (
                <span className="font-semibold tabular-nums">
                  {format(selection.total)} of {format(selection.billed)}
                  {" · "}
                </span>
              ) : null}
              {statusText}
            </p>
            {!locked ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  className="h-7 px-2.5 text-[11px]"
                  disabled={busy || !selection.dirty || hasErrors}
                  onClick={() => {
                    if (busy || hasErrors || !selection.dirty) return;
                    onAllocate(line.index, selection.allocations);
                    setEdits({});
                  }}
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  Apply selection
                </Button>
                {line.manual || Object.keys(edits).length ? (
                  <Button
                    variant="ghost"
                    className="h-7 px-2.5 text-[11px] text-[#6b5d50]"
                    disabled={busy}
                    onClick={() => {
                      setEdits({});
                      if (line.manual) onResetAllocation(line.index);
                    }}
                  >
                    <RotateCcw className="h-3 w-3" />
                    Restore automatic selection
                  </Button>
                ) : null}
              </div>
            ) : null}
          </footer>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
