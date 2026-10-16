"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { Content as DialogContent } from "@radix-ui/react-dialog";
import { Check, ChevronRight, Search, X } from "lucide-react";
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
import { formatDate, inr, qty } from "./format";

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

const words = (text: string) =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (word) => word.length >= 3 && !/^\d+$/.test(word),
  );
const sameWord = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/** Words the invoice line and a PO line both use, e.g. "CRS" in "CRS550D" and "CRS RCP's". */
export function sharedWords(invoiceText: string, poText: string) {
  const po = words(poText);
  return [
    ...new Set(
      words(invoiceText).filter((w) => po.some((o) => sameWord(w, o))),
    ),
  ];
}

function Marked({ text, shared }: { text: string; shared: string[] }) {
  if (!shared.length) return <>{text}</>;
  return (
    <>
      {text.split(/([A-Za-z0-9]+)/).map((part, index) =>
        part && shared.some((word) => sameWord(part.toLowerCase(), word)) ? (
          <mark
            key={index}
            className="rounded-sm bg-[#fdf1dc] px-0.5 text-inherit"
          >
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function CompareRow({
  label,
  invoice,
  po,
  ok,
  children,
}: {
  label: string;
  invoice: ReactNode;
  po: ReactNode;
  ok: boolean | null;
  children?: ReactNode;
}) {
  const tone = ok === null ? "unknown" : ok ? "same" : "diff";
  return (
    <div className="dt-r" role="row">
      <span className="dt-k" role="rowheader">
        {label}
      </span>
      <span className="dt-v" role="cell">
        {invoice}
      </span>
      <span className={`dt-v ${tone}`} role="cell">
        {ok === null ? null : <span className="st-i">{ok ? "✓" : "≠"}</span>}
        <span>
          {po}
          {children}
        </span>
      </span>
    </div>
  );
}

function Detail({
  line,
  invoiceText,
  candidate,
  shared,
}: {
  line: LineResult;
  invoiceText: string;
  candidate: CandidateView;
  shared: string[];
}) {
  const amount = line.invoiceAmount ?? 0;
  const openQuantity = candidate.poEvidence?.openQuantity ?? null;
  const qtyOk =
    line.invoiceQty == null || openQuantity == null
      ? null
      : Math.abs(line.invoiceQty - openQuantity) < EPSILON;
  const priceOk =
    line.invoiceRate == null || candidate.price == null
      ? null
      : Math.abs(line.invoiceRate - candidate.price) < EPSILON;
  const enough = amount <= candidate.open + EPSILON;
  const headerRemarks = candidate.poEvidence?.headerRemarks;
  const good = qtyOk && priceOk && enough;
  return (
    <div className="dt">
      <p className={`dt-sum ${good ? "strong" : ""}`}>
        {candidate.rejected
          ? candidate.rejected
          : good
            ? "Quantity and price are the same"
            : [
                qtyOk === false ? "Quantity differs" : "",
                priceOk === false ? "Unit price differs" : "",
                !enough ? "Not enough left on this PO line" : "",
              ]
                .filter(Boolean)
                .join(" · ") || "Nothing to compare yet"}
      </p>
      {candidate.rejected ? null : (
        <>
          <div className="dt-grid" role="table">
            <div className="dt-h" role="row">
              <span role="columnheader" />
              <span role="columnheader">This invoice line</span>
              <span role="columnheader">
                PO {candidate.docNum} · line {(candidate.lineNum ?? 0) + 1}
              </span>
            </div>
            <CompareRow
              label="Description"
              ok={null}
              invoice={<Marked text={invoiceText} shared={shared} />}
              po={<Marked text={poLineTitle(candidate)} shared={shared} />}
            >
              {shared.length ? (
                <small>Words in common: {shared.join(", ")}</small>
              ) : null}
              {headerRemarks ? <small>{headerRemarks}</small> : null}
            </CompareRow>
            <CompareRow
              label="Quantity"
              ok={qtyOk}
              invoice={qty(line.invoiceQty)}
              po={qty(openQuantity)}
            />
            <CompareRow
              label="Unit price"
              ok={priceOk}
              invoice={inr(line.invoiceRate)}
              po={inr(candidate.price)}
            />
            <CompareRow
              label="Amount"
              ok={enough}
              invoice={inr(amount)}
              po={`${inr(candidate.open)} left`}
            />
          </div>
          <dl className="dt-facts">
            <div>
              <dt>SAP item</dt>
              <dd>{candidate.itemCode || "—"}</dd>
            </div>
            <div>
              <dt>PO date</dt>
              <dd>{formatDate(candidate.date)}</dd>
            </div>
            <div>
              <dt>Item type</dt>
              <dd>Non-stock</dd>
            </div>
          </dl>
        </>
      )}
    </div>
  );
}

/** Drawer for choosing which line of one SAP PO an invoice line belongs to. */
export function NonStockPoDrawer({
  open,
  onOpenChange,
  invoice,
  line,
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
  line: LineResult;
  /** Every invoice line, to see what the others already take from each PO line. */
  lines: LineResult[];
  poDocEntry: number;
  poLabel: string;
  busy: boolean;
  locked: boolean;
  onAllocate: (index: number, allocations: Record<string, number>) => void;
}) {
  const source = invoice.lines.find((entry) => entry.index === line.index);
  const invoiceText = source?.description || `Invoice line ${line.index + 1}`;
  const amount = line.invoiceAmount ?? 0;
  const confirmed = confirmedPoCandidate(line);
  const [edit, setEdit] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [folds, setFolds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const pick = locked
    ? (confirmed?.key ?? null)
    : (edit ?? confirmed?.key ?? null) || null;

  const pool = poCandidatesOf(line).filter(
    (candidate) => candidate.docEntry === poDocEntry,
  );
  /** What other invoice lines have already confirmed on the same PO line. */
  const claimedBy = (key: string) =>
    lines.reduce((sum, other) => {
      if (other.index === line.index) return sum;
      return other.candidates.some(
        (candidate) => candidate.key === key && candidate.allocated > 0,
      )
        ? sum + (other.invoiceAmount ?? 0)
        : sum;
    }, 0);
  const leftOf = (candidate: CandidateView) =>
    (candidate.open ?? 0) - claimedBy(candidate.key);
  const sharedBy = (candidate: CandidateView) =>
    sharedWords(invoiceText, poLineTitle(candidate));
  // Words every PO line shares say nothing; only words that tell lines apart are shown.
  const telling = (candidate: CandidateView) =>
    sharedBy(candidate).filter(
      (word) =>
        !pool.every((other) => sharedBy(other).some((w) => sameWord(w, word))),
    );
  const available = (candidate: CandidateView) =>
    !candidate.rejected && leftOf(candidate) >= amount - EPSILON;

  const query = search.trim().toLowerCase();
  const matches = (candidate: CandidateView) =>
    !query ||
    `${(candidate.lineNum ?? 0) + 1} ${poLineTitle(candidate)}`
      .toLowerCase()
      .includes(query);
  const groups = [
    {
      key: "fit",
      title: "Same quantity and price",
      xs: pool.filter(
        (candidate) =>
          fitsInvoiceLine(line, candidate) &&
          (available(candidate) || pick === candidate.key),
      ),
      fold: false,
    },
    {
      key: "other",
      title: "Other lines on this PO",
      xs: pool.filter(
        (candidate) =>
          !candidate.rejected &&
          !(
            fitsInvoiceLine(line, candidate) &&
            (available(candidate) || pick === candidate.key)
          ),
      ),
      fold: true,
    },
    {
      key: "na",
      title: "Not available",
      xs: pool.filter((candidate) => candidate.rejected),
      fold: true,
    },
  ]
    .map((group) => ({ ...group, shown: group.xs.filter(matches) }))
    .filter((group) => group.shown.length);
  const hasMain = groups.some((group) => !group.fold);
  const fitRows = groups.find((group) => group.key === "fit")?.shown ?? [];
  const indistinct =
    fitRows.length > 1 && fitRows.every((entry) => !telling(entry).length);

  const chosen = pool.find((candidate) => candidate.key === pick);
  const over = chosen ? amount > leftOf(chosen) + EPSILON : false;
  const dirty = Boolean(pick) && pick !== confirmed?.key;
  const meterStatus: "ok" | "over" | "short" = !chosen
    ? "short"
    : over
      ? "over"
      : "ok";
  const meterLabel = !chosen
    ? `${inr(amount)} to place`
    : over
      ? `Only ${inr(Math.max(leftOf(chosen), 0))} left on this line`
      : locked
        ? "Saved choice"
        : "Adds up";
  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  };
  const close = () => {
    setEdit(null);
    setSearch("");
    onOpenChange(false);
  };

  const renderRow = (candidate: CandidateView) => {
    const isPicked = pick === candidate.key;
    const isOpen = expanded.has(candidate.key);
    const na = Boolean(candidate.rejected);
    const left = leftOf(candidate);
    const short = !na && amount > left + EPSILON;
    const tell = telling(candidate);
    const priceDiffers =
      line.invoiceRate != null &&
      candidate.price != null &&
      Math.abs(line.invoiceRate - candidate.price) > EPSILON;
    const qtyDiffers =
      line.invoiceQty != null &&
      candidate.poEvidence?.openQuantity != null &&
      Math.abs(line.invoiceQty - candidate.poEvidence.openQuantity) > EPSILON;
    const tag = na
      ? null
      : priceDiffers
        ? { tone: "none", text: "Price differs" }
        : qtyDiffers
          ? { tone: "none", text: "Quantity differs" }
          : short
            ? { tone: "conflict", text: "Not enough left" }
            : fitsInvoiceLine(line, candidate)
              ? { tone: "strong", text: "Qty and price fit" }
              : { tone: "none", text: "Check price and qty" };
    const note =
      short && !isPicked
        ? claimedBy(candidate.key)
          ? `Other invoice lines already use ${inr(claimedBy(candidate.key))} of this PO line · ${inr(Math.max(left, 0))} left.`
          : `Only ${inr(Math.max(left, 0))} left on this PO line.`
        : "";
    return (
      <li
        key={candidate.key}
        className={`gr ${isPicked ? "picked" : ""} ${isOpen ? "open" : ""} v-${na ? "na" : short ? "conflict" : "strong"}`}
        style={{ "--seg": "#3f8a63" } as CSSProperties}
      >
        <div className="gr-main">
          {locked || na ? (
            <span
              className={`gr-check ${na ? "na" : isPicked ? "on" : ""}`}
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
              aria-label={`Use PO line ${(candidate.lineNum ?? 0) + 1}`}
              disabled={busy}
              onClick={() => setEdit(isPicked ? "" : candidate.key)}
            >
              <Check strokeWidth={3} />
            </button>
          )}
          <button
            type="button"
            className="gr-body"
            aria-expanded={isOpen}
            style={{ gridTemplateColumns: "1fr 128px 16px" }}
            onClick={() =>
              setExpanded((current) => toggle(current, candidate.key))
            }
          >
            <span className="gr-id">
              <b className="truncate">
                Line {(candidate.lineNum ?? 0) + 1} · {poLineTitle(candidate)}
              </b>
              <small>
                {qty(candidate.poEvidence?.openQuantity)} ×{" "}
                {inr(candidate.price)}
                {tell.length && fitsInvoiceLine(line, candidate)
                  ? ` · name has ${tell[0].toUpperCase()}`
                  : ""}
              </small>
            </span>
            {na ? (
              <span className="gr-na">{candidate.rejected}</span>
            ) : tag ? (
              <span className={`verdict ${tag.tone}`}>{tag.text}</span>
            ) : null}
            <span className="gr-chev">
              <ChevronRight />
            </span>
          </button>
          {isPicked ? (
            <span className="gr-qty picked">
              <span className="gr-alloc">
                <span className="num">{inr(amount)}</span>
                <small>of {inr(candidate.open)}</small>
              </span>
              <span className={`gr-use ${over ? "over" : ""}`}>
                <span
                  style={{
                    width: `${candidate.open > 0 ? Math.min(100, Math.round((amount / candidate.open) * 100)) : 0}%`,
                  }}
                />
              </span>
            </span>
          ) : (
            <span className="gr-qty">
              <span className="num">{inr(Math.max(left, 0))}</span>
              <small>left</small>
            </span>
          )}
        </div>
        <div className={`gr-note ${short ? "error" : ""}`}>{note}</div>
        {isOpen ? (
          <Detail
            line={line}
            invoiceText={invoiceText}
            candidate={candidate}
            shared={sharedBy(candidate)}
          />
        ) : null}
      </li>
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
    >
      <DialogPortal>
        <DialogOverlay className="bg-[rgba(28,20,14,0.28)] backdrop-blur-none" />
        <DialogContent className="gd fixed inset-y-0 right-0 z-50 flex h-dvh w-full max-w-[640px] flex-col bg-white shadow-[-24px_0_48px_rgba(43,26,16,0.14)] outline-none duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right motion-reduce:animate-none">
          <header className="v3-head">
            <div className="v3-top">
              <div>
                <DialogDescription className="eyebrow">
                  {invoiceText} · invoice line {line.index + 1} ·{" "}
                  {qty(line.invoiceQty)} × {inr(line.invoiceRate)}
                </DialogDescription>
                <DialogTitle asChild>
                  <h2>
                    {locked
                      ? "PO line this invoice line was matched to"
                      : "Which PO line is this?"}
                  </h2>
                </DialogTitle>
                <p className="eyebrow" style={{ marginTop: 4 }}>
                  {poLabel}
                </p>
              </div>
              <DialogClose className="icon-btn" aria-label="Close">
                <X size={16} />
              </DialogClose>
            </div>
            <div className="meter">
              <div className="m-row">
                <span className="m-big num">
                  {inr(chosen ? amount : 0)}
                  <span> / {inr(amount)}</span>
                </span>
                <span className={`m-state ${meterStatus}`}>
                  {meterStatus === "ok" ? <Check /> : null}
                  {meterLabel}
                </span>
              </div>
              <div className="seg">
                <span
                  style={{
                    flexBasis: chosen ? "100%" : "0%",
                    background: over ? "#c2412f" : "#3f8a63",
                  }}
                />
              </div>
              <div className="seg-legend">
                <span>
                  {chosen
                    ? `PO line ${(chosen.lineNum ?? 0) + 1} · ${poLineTitle(chosen)}`
                    : "No PO line picked"}
                </span>
              </div>
            </div>
            {pool.length > 8 ? (
              <label className="v3-search">
                <Search size={15} />
                <input
                  aria-label="Search PO lines"
                  placeholder="Find by line number or description"
                  autoComplete="off"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
            ) : null}
          </header>
          <div className="v3-body">
            {groups.length ? (
              groups.map((group) => {
                const isOpen =
                  !group.fold ||
                  Boolean(query) ||
                  folds.has(group.key) ||
                  (!hasMain && !folds.has(`x:${group.key}`));
                return (
                  <section className="grp" key={group.key}>
                    <div className="grp-bar">
                      <button
                        type="button"
                        className="grp-head"
                        disabled={!group.fold}
                        aria-expanded={group.fold ? isOpen : undefined}
                        onClick={() => {
                          if (!group.fold) return;
                          const auto = !hasMain && !folds.has(group.key);
                          setFolds((current) =>
                            toggle(
                              current,
                              auto && isOpen ? `x:${group.key}` : group.key,
                            ),
                          );
                        }}
                      >
                        {group.fold ? (
                          <span className={`grp-chev ${isOpen ? "down" : ""}`}>
                            <ChevronRight />
                          </span>
                        ) : null}
                        <span>{group.title}</span>
                        <span className="grp-count">{group.shown.length}</span>
                      </button>
                    </div>
                    {isOpen && group.key === "fit" && indistinct ? (
                      <p className="mb-1 text-[11px] text-[#6b5d50]">
                        These lines fit equally. Nothing on the invoice line
                        tells them apart, so check the PO or the supplier.
                      </p>
                    ) : null}
                    {isOpen ? (
                      <ul className="gr-list">{group.shown.map(renderRow)}</ul>
                    ) : null}
                  </section>
                );
              })
            ) : (
              <p className="empty">
                {query
                  ? `No PO line matches “${search}”.`
                  : "This PO has no open non-stock line for this invoice line."}
              </p>
            )}
          </div>
          <footer className="v3-foot">
            <span
              role="status"
              aria-live="polite"
              className={`f-msg ${over ? "error" : ""}`}
            >
              {locked
                ? "Read-only"
                : over
                  ? "Pick a line with enough left"
                  : dirty
                    ? "Ready to apply"
                    : confirmed
                      ? "No changes"
                      : "Pick the PO line this invoice line belongs to"}
            </span>
            <button type="button" className="btn ghost" onClick={close}>
              {dirty && !locked ? "Discard" : "Close"}
            </button>
            {!locked ? (
              <button
                type="button"
                className="btn primary"
                disabled={busy || !dirty || over}
                onClick={() => {
                  if (!pick) return;
                  onAllocate(line.index, { [pick]: amount });
                  close();
                }}
              >
                Apply
              </button>
            ) : null}
          </footer>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
