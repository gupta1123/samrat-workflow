"use client";

import { useEffect, useRef, useState } from "react";
import { Content as DialogContent } from "@radix-ui/react-dialog";
import { Check, X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  CandidateView,
  LineResult,
  MatchInvoice,
} from "@/lib/sap-match/types";
import { inr, qty } from "./format";
import { factsFor } from "./ServicePoCandidates";

const EPSILON = 0.005;

export function poCandidatesOf(line: LineResult) {
  return (
    line.kind === "unmapped"
      ? (line.nonStockPoCandidates ?? [])
      : line.candidates
  ).filter(
    (candidate) =>
      candidate.kind === "PO" && candidate.documentType === "dDocument_Items",
  );
}

export function poLineTitle(candidate: CandidateView) {
  return (
    candidate.poEvidence?.lineRemarks ||
    candidate.poEvidence?.description ||
    candidate.itemName ||
    "No description"
  );
}

/** Exact quantity and price: a stated fact used only to group the choices, never to pick one. */
export function fitsInvoiceLine(line: LineResult, candidate: CandidateView) {
  return (
    line.invoiceQty != null &&
    line.invoiceRate != null &&
    candidate.poEvidence?.openQuantity != null &&
    candidate.price != null &&
    Math.abs(line.invoiceQty - candidate.poEvidence.openQuantity) < EPSILON &&
    Math.abs(line.invoiceRate - candidate.price) < EPSILON
  );
}

export function confirmedPoCandidate(line: LineResult) {
  return line.candidates.find(
    (candidate) => candidate.kind === "PO" && candidate.allocated > 0,
  );
}

/** Drawer for matching every invoice line to a line of one SAP PO in a single pass. */
export function NonStockPoDrawer({
  open,
  onOpenChange,
  invoice,
  lines,
  poDocEntry,
  poLabel,
  busy,
  locked,
  onAllocate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: MatchInvoice;
  lines: LineResult[];
  poDocEntry: number;
  poLabel: string;
  busy: boolean;
  locked: boolean;
  onAllocate: (index: number, allocations: Record<string, number>) => void;
}) {
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [queue, setQueue] = useState<Array<[number, string]>>([]);
  const sent = useRef<[number, string] | null>(null);
  const [failed, setFailed] = useState<number | null>(null);

  // Lines still to match are the ones with no confirmed PO line yet.
  const todo = lines.filter((line) => !confirmedPoCandidate(line));
  const changes = todo.filter((line) => picks[line.index]);

  // Apply one line at a time: each save is validated against SAP before the next.
  useEffect(() => {
    if (busy) return;
    if (sent.current) {
      const [index, key] = sent.current;
      const line = lines.find((entry) => entry.index === index);
      const saved = line?.candidates.some(
        (candidate) => candidate.key === key && candidate.allocated > 0,
      );
      sent.current = null;
      if (!saved) {
        setQueue([]);
        setFailed(index);
        return;
      }
    }
    if (!queue.length) return;
    const [next, ...rest] = queue;
    sent.current = next;
    setQueue(rest);
    const line = lines.find((entry) => entry.index === next[0]);
    onAllocate(next[0], { [next[1]]: line?.invoiceAmount ?? 0 });
  }, [busy, queue, lines, onAllocate]);

  const applying = queue.length > 0 || sent.current !== null;
  useEffect(() => {
    if (!applying && !failed && open && !todo.length) onOpenChange(false);
  }, [applying, failed, open, todo.length, onOpenChange]);

  const pickedAmount = (key: string, except: number) =>
    lines.reduce((sum, other) => {
      if (other.index === except) return sum;
      const taken =
        picks[other.index] === key ||
        other.candidates.some(
          (candidate) => candidate.key === key && candidate.allocated > 0,
        );
      return taken ? sum + (other.invoiceAmount ?? 0) : sum;
    }, 0);

  const overdrawn = changes.some((line) => {
    const candidate = poCandidatesOf(line).find(
      (entry) => entry.key === picks[line.index],
    );
    return (
      !candidate ||
      (line.invoiceAmount ?? 0) + pickedAmount(candidate.key, line.index) >
        (candidate.open ?? 0) + EPSILON
    );
  });
  const total = lines.reduce((sum, line) => sum + (line.invoiceAmount ?? 0), 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !applying) setPicks({});
        if (!next) setFailed(null);
        onOpenChange(next);
      }}
    >
      <DialogPortal>
        <DialogOverlay className="bg-[rgba(28,20,14,0.28)] backdrop-blur-none" />
        <DialogContent className="fixed inset-y-0 right-0 z-50 flex h-dvh w-full max-w-[640px] flex-col bg-white text-[12px] text-[#111827] shadow-[-24px_0_48px_rgba(43,26,16,0.14)] outline-none duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right motion-reduce:animate-none">
          <header className="flex items-start justify-between gap-3 border-b border-[#ece6dc] px-5 py-4">
            <div className="min-w-0">
              <DialogDescription className="text-[11px] text-[#6b5d50]">
                {poLabel}
              </DialogDescription>
              <DialogTitle asChild>
                <h2 className="mt-1 text-[18px] font-semibold leading-tight">
                  {locked
                    ? "PO lines this invoice was matched to"
                    : "Which PO line is each invoice line?"}
                </h2>
              </DialogTitle>
              <p className="mt-1 tabular-nums text-[#6b5d50]">
                {lines.length - todo.length} of {lines.length} lines matched ·
                invoice {inr(total)}
              </p>
            </div>
            <DialogClose
              className="-mr-2 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[#6b5d50] hover:bg-[#f0ece4]"
              aria-label="Close"
            >
              <X size={16} />
            </DialogClose>
          </header>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
            {lines.map((line) => {
              const source = invoice.lines.find(
                (entry) => entry.index === line.index,
              );
              const confirmed = confirmedPoCandidate(line);
              const pool = poCandidatesOf(line).filter(
                (candidate) => candidate.docEntry === poDocEntry,
              );
              const fitting = pool.filter((candidate) =>
                fitsInvoiceLine(line, candidate),
              );
              const others = pool.filter(
                (candidate) => !fitsInvoiceLine(line, candidate),
              );
              const amount = line.invoiceAmount ?? 0;
              const row = (candidate: CandidateView) => {
                const claimed = pickedAmount(candidate.key, line.index);
                const left = (candidate.open ?? 0) - claimed;
                const short = amount > left + EPSILON;
                const disabled =
                  Boolean(candidate.rejected) || short || locked || applying;
                const checked = picks[line.index] === candidate.key;
                const facts = factsFor(candidate, source, amount).facts.filter(
                  (fact) => fact.tone !== "ok" && !fact.text.startsWith("Item"),
                );
                return (
                  <li key={candidate.key}>
                    <label
                      className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 ${checked ? "border-[#3f8a63] bg-[#f1f8f4]" : "border-[#e0d8cc] bg-white hover:bg-[#faf8f4]"} ${disabled && !checked ? "cursor-not-allowed opacity-60" : ""}`}
                    >
                      <input
                        type="radio"
                        className="mt-0.5"
                        name={`po-line-${line.index}`}
                        checked={checked}
                        disabled={disabled}
                        onChange={() => {
                          setFailed(null);
                          setPicks((current) => ({
                            ...current,
                            [line.index]: candidate.key,
                          }));
                        }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <span className="font-medium">
                            Line {(candidate.lineNum ?? 0) + 1} ·{" "}
                            {poLineTitle(candidate)}
                          </span>
                          <span className="tabular-nums text-[#3d3530]">
                            {qty(candidate.poEvidence?.openQuantity)} ×{" "}
                            {inr(candidate.price)}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-[11px]">
                          {candidate.rejected ? (
                            <span className="text-[#6b5d50]">
                              {candidate.rejected === "Fully billed already"
                                ? "Already fully billed"
                                : candidate.rejected}
                            </span>
                          ) : short ? (
                            <span className="text-[#b3261e]">
                              Only {inr(Math.max(left, 0))} left
                              {claimed ? " after the lines picked above" : ""}
                            </span>
                          ) : facts.length ? (
                            facts.map((fact) => (
                              <span
                                key={fact.text}
                                className={`mr-3 ${fact.tone === "bad" ? "text-[#b3261e]" : "text-[#8a5207]"}`}
                              >
                                {fact.text}
                              </span>
                            ))
                          ) : (
                            <span className="text-[#3d5a47]">
                              ✓ Quantity and price match · {inr(left)} left
                            </span>
                          )}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              };
              return (
                <section
                  key={line.index}
                  aria-label={`Invoice line ${line.index + 1}`}
                >
                  <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3">
                    <h3 className="text-[13px] font-semibold">
                      {line.index + 1}.{" "}
                      {source?.description || `Invoice line ${line.index + 1}`}
                    </h3>
                    <span className="tabular-nums text-[#6b5d50]">
                      {qty(line.invoiceQty)} × {inr(line.invoiceRate)} ={" "}
                      {inr(amount)}
                    </span>
                  </div>
                  {confirmed ? (
                    <p className="flex items-center gap-1.5 rounded-lg border border-[#c4dfcf] bg-[#f1f8f4] px-3 py-2 font-medium text-[#24583e]">
                      <Check size={14} /> PO {confirmed.docNum} · Line{" "}
                      {(confirmed.lineNum ?? 0) + 1} · {poLineTitle(confirmed)}
                    </p>
                  ) : (
                    <>
                      {fitting.length ? (
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[#8a7f72]">
                          Same quantity and price
                        </p>
                      ) : null}
                      <ul className="space-y-1.5">{fitting.map(row)}</ul>
                      {others.length ? (
                        <>
                          {fitting.length ? (
                            <p className="mb-1 mt-2.5 text-[10px] font-medium uppercase tracking-wider text-[#8a7f72]">
                              Other lines
                            </p>
                          ) : null}
                          <ul className="space-y-1.5">{others.map(row)}</ul>
                        </>
                      ) : null}
                      {!pool.length ? (
                        <p className="text-[#6b5d50]">
                          This PO has no open non-stock line for this invoice
                          line.
                        </p>
                      ) : null}
                    </>
                  )}
                </section>
              );
            })}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-[#ece6dc] px-5 py-3">
            <span
              className={`min-w-0 text-[11px] ${failed !== null ? "text-[#b3261e]" : "text-[#6b5d50]"}`}
              role="status"
            >
              {failed !== null
                ? `Line ${failed + 1} could not be saved. Pick it again.`
                : applying
                  ? "Saving and checking against SAP…"
                  : todo.length
                    ? `${changes.length} of ${todo.length} open lines chosen`
                    : "All lines matched"}
            </span>
            <span className="flex shrink-0 gap-2">
              <button
                type="button"
                className="h-8 rounded-md border border-[#d4c9bc] bg-white px-3 text-[12px] font-medium text-[#5d422e] hover:bg-[#f0ece4]"
                onClick={() => {
                  setPicks({});
                  onOpenChange(false);
                }}
                disabled={applying}
              >
                {changes.length ? "Discard" : "Close"}
              </button>
              {!locked ? (
                <button
                  type="button"
                  className="h-8 rounded-md bg-[#2b1a10] px-3 text-[12px] font-medium text-white disabled:opacity-40"
                  disabled={busy || applying || !changes.length || overdrawn}
                  onClick={() => {
                    setFailed(null);
                    setQueue(
                      changes.map((line) => [line.index, picks[line.index]]),
                    );
                    setPicks({});
                  }}
                >
                  {changes.length > 1
                    ? `Apply ${changes.length} lines`
                    : "Apply"}
                </button>
              ) : null}
            </span>
          </footer>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
