"use client";

import { useState, type CSSProperties } from "react";
import { Content as DialogContent } from "@radix-ui/react-dialog";
import { Check, ChevronRight, X } from "lucide-react";
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
import { formatDate, inr } from "./format";
import {
  CompareRow,
  fitsInvoiceLine,
  poCandidatesOf,
} from "./NonStockPoDrawer";

const EPSILON = 0.005;

/** Drawer for choosing which supplier PO the invoice is matched against. */
export function NonStockPoPicker({
  open,
  onOpenChange,
  invoice,
  lines,
  pos,
  citedDocEntries,
  currentDocEntry,
  locked,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: MatchInvoice;
  lines: LineResult[];
  /** One entry per supplier PO that has open non-stock lines. */
  pos: CandidateView[];
  citedDocEntries: number[];
  currentDocEntry: number | null;
  /** True once a line is matched: the PO can no longer be switched. */
  locked: boolean;
  onChoose: (docEntry: number) => void;
}) {
  const [pick, setPick] = useState<number | null>(currentDocEntry);
  const [expanded, setExpanded] = useState<Set<number>>(
    new Set(currentDocEntry ? [currentDocEntry] : []),
  );
  const [showOthers, setShowOthers] = useState(false);
  const invoiceTotal = lines.reduce(
    (sum, line) => sum + (line.invoiceAmount ?? 0),
    0,
  );
  const poLines = (docEntry: number) => [
    ...new Map(
      lines
        .flatMap(poCandidatesOf)
        .filter((candidate) => candidate.docEntry === docEntry)
        .map((candidate) => [candidate.key, candidate]),
    ).values(),
  ];
  const facts = (po: CandidateView) => {
    const own = poLines(po.docEntry).filter((candidate) => !candidate.rejected);
    const left = own.reduce((sum, candidate) => sum + (candidate.open ?? 0), 0);
    const fitting = lines.filter((line) =>
      own.some((candidate) => fitsInvoiceLine(line, candidate)),
    ).length;
    return {
      lines: own.length,
      left,
      fitting,
      enough: left + EPSILON >= invoiceTotal,
      cited: citedDocEntries.includes(po.docEntry),
    };
  };
  const toggle = (docEntry: number) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(docEntry)) next.add(docEntry);
      return next;
    });
  const cited = pos.filter((po) => citedDocEntries.includes(po.docEntry));
  const others = pos
    .filter((po) => !citedDocEntries.includes(po.docEntry))
    .sort(
      (a, b) =>
        Number(facts(b).enough) - Number(facts(a).enough) ||
        facts(b).fitting - facts(a).fitting,
    );
  const chosen = pos.find((po) => po.docEntry === pick);
  const chosenFacts = chosen ? facts(chosen) : null;
  const dirty = pick !== null && pick !== currentDocEntry;

  const renderRow = (po: CandidateView) => {
    const info = facts(po);
    const isPicked = pick === po.docEntry;
    const isOpen = expanded.has(po.docEntry);
    const tag = info.cited
      ? { tone: "strong", text: "Cited on invoice" }
      : !info.enough
        ? { tone: "conflict", text: "Not enough left" }
        : info.fitting
          ? {
              tone: "maybe",
              text: `${info.fitting} of ${lines.length} lines fit`,
            }
          : { tone: "none", text: "Not on invoice" };
    return (
      <li
        key={po.docEntry}
        className={`gr ${isPicked ? "picked" : ""} ${isOpen ? "open" : ""}`}
        style={{ "--seg": "#3f8a63" } as CSSProperties}
      >
        <div className="gr-main">
          {locked ? (
            <span
              className={`gr-check ${isPicked ? "on" : ""}`}
              aria-hidden="true"
            >
              {isPicked ? <Check strokeWidth={3} /> : null}
            </span>
          ) : (
            <button
              type="button"
              className={`gr-check ${isPicked ? "on" : ""}`}
              role="checkbox"
              aria-checked={isPicked}
              aria-label={`Use PO ${po.docNum}`}
              onClick={() => setPick(isPicked ? null : po.docEntry)}
            >
              <Check strokeWidth={3} />
            </button>
          )}
          <button
            type="button"
            className="gr-body"
            style={{ gridTemplateColumns: "minmax(0,1fr) auto 16px" }}
            aria-expanded={isOpen}
            onClick={() => toggle(po.docEntry)}
          >
            <span className="gr-id">
              <b>PO {po.docNum}</b>
              <small>
                {formatDate(po.date)} · {info.lines} open{" "}
                {info.lines === 1 ? "line" : "lines"}
              </small>
            </span>
            <span className={`verdict ${tag.tone}`}>{tag.text}</span>
            <span className="gr-chev">
              <ChevronRight />
            </span>
          </button>
          <span className="gr-qty">
            <span className="num">{inr(info.left)}</span>
            <small>left</small>
          </span>
        </div>
        {isOpen ? (
          <div className="dt">
            <p
              className={`dt-sum ${info.cited && info.enough ? "strong" : ""}`}
            >
              {info.cited
                ? "The invoice cites this PO"
                : "The invoice does not cite this PO"}
              {info.enough ? "" : " · not enough left for this invoice"}
            </p>
            <div className="dt-grid" role="table">
              <div className="dt-h" role="row">
                <span role="columnheader" />
                <span role="columnheader">This invoice</span>
                <span role="columnheader">PO {po.docNum}</span>
              </div>
              <CompareRow
                label="PO number"
                ok={info.cited}
                invoice={invoice.poReferences.join(", ") || "None printed"}
                po={[
                  ...new Set(
                    [po.docNum, ...(po.references?.po ?? [])]
                      .filter(Boolean)
                      .map(String),
                  ),
                ].join(", ")}
              />
              <CompareRow
                label="Amount"
                ok={info.enough}
                invoice={inr(invoiceTotal)}
                po={`${inr(info.left)} left`}
              />
              <CompareRow
                label="Lines"
                ok={info.fitting === lines.length}
                invoice={`${lines.length} invoice lines`}
                po={`${info.fitting} of ${lines.length} have a same quantity and price line`}
              />
            </div>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="bg-[rgba(28,20,14,0.28)] backdrop-blur-none" />
        <DialogContent className="gd fixed inset-y-0 right-0 z-50 flex h-dvh w-full max-w-[640px] flex-col bg-white shadow-[-24px_0_48px_rgba(43,26,16,0.14)] outline-none duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right motion-reduce:animate-none">
          <header className="v3-head">
            <div className="v3-top">
              <div>
                <DialogDescription className="eyebrow">
                  {invoice.vendorName ?? "Supplier"} · invoice cites{" "}
                  {invoice.poReferences.join(", ") || "no PO"}
                </DialogDescription>
                <DialogTitle asChild>
                  <h2>
                    {locked
                      ? "PO this invoice is matched to"
                      : "Which PO is this invoice for?"}
                  </h2>
                </DialogTitle>
              </div>
              <DialogClose className="icon-btn" aria-label="Close">
                <X size={16} />
              </DialogClose>
            </div>
            <div className="meter">
              <div className="m-row">
                <span className="m-big num">
                  {inr(
                    chosenFacts ? Math.min(chosenFacts.left, invoiceTotal) : 0,
                  )}
                  <span> / {inr(invoiceTotal)}</span>
                </span>
                <span
                  className={`m-state ${!chosen ? "short" : chosenFacts?.enough ? "ok" : "over"}`}
                >
                  {chosen && chosenFacts?.enough ? <Check /> : null}
                  {!chosen
                    ? "No PO picked"
                    : chosenFacts?.enough
                      ? "Covers the invoice"
                      : `${inr(invoiceTotal - (chosenFacts?.left ?? 0))} short`}
                </span>
              </div>
              <div className="seg">
                <span
                  style={{
                    flexBasis: chosenFacts
                      ? `${Math.min(100, (chosenFacts.left / (invoiceTotal || 1)) * 100)}%`
                      : "0%",
                    background: chosenFacts?.enough ? "#3f8a63" : "#c2412f",
                  }}
                />
              </div>
              <div className="seg-legend">
                <span>
                  {chosen
                    ? `PO ${chosen.docNum} · ${inr(chosenFacts?.left)} left`
                    : `${pos.length} supplier POs have open non-stock lines`}
                </span>
              </div>
            </div>
          </header>
          <div className="v3-body">
            {cited.length ? (
              <section className="grp">
                <div className="grp-bar">
                  <span className="grp-head" style={{ cursor: "default" }}>
                    Cited on the invoice
                    <span className="grp-count">{cited.length}</span>
                  </span>
                </div>
                <ul className="gr-list">{cited.map(renderRow)}</ul>
              </section>
            ) : null}
            {others.length ? (
              <section className="grp">
                <div className="grp-bar">
                  <button
                    type="button"
                    className="grp-head"
                    aria-expanded={showOthers || !cited.length}
                    disabled={!cited.length}
                    onClick={() => setShowOthers((value) => !value)}
                  >
                    {cited.length ? (
                      <span className={`grp-chev ${showOthers ? "down" : ""}`}>
                        <ChevronRight />
                      </span>
                    ) : null}
                    <span>{cited.length ? "Other open POs" : "Open POs"}</span>
                    <span className="grp-count">{others.length}</span>
                  </button>
                </div>
                {showOthers || !cited.length ? (
                  <ul className="gr-list">{others.map(renderRow)}</ul>
                ) : null}
              </section>
            ) : null}
          </div>
          <footer className="v3-foot">
            <span role="status" aria-live="polite" className="f-msg">
              {locked
                ? "A line is already matched, so the PO cannot change"
                : dirty
                  ? "Ready to use"
                  : pick
                    ? "No changes"
                    : "Pick the PO this invoice belongs to"}
            </span>
            <button
              type="button"
              className="btn ghost"
              onClick={() => onOpenChange(false)}
            >
              {dirty && !locked ? "Discard" : "Close"}
            </button>
            {!locked ? (
              <button
                type="button"
                className="btn primary"
                disabled={!dirty}
                onClick={() => {
                  if (pick !== null) onChoose(pick);
                }}
              >
                Use this PO
              </button>
            ) : null}
          </footer>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
