"use client";

import "./grpo-drawer.css";
import { useState, type CSSProperties } from "react";
import { Content as DialogContent } from "@radix-ui/react-dialog";
import { Check, ChevronRight, Search, X } from "lucide-react";
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
import { candidateEvidence } from "@/lib/sap-match/evidence";
import { SAP_TERMS } from "@/lib/sap-match/terminology";
import type { LineResult, MatchInvoice } from "@/lib/sap-match/types";
import { formatDate, inr, qty } from "./format";

const SEG_COLORS = ["#3f8a63", "#5f7fb8", "#c08a3e", "#8a5fb0", "#3f8a8a"];

type Verdict = "strong" | "maybe" | "conflict" | "none" | "na";
const VERDICT_LABEL: Record<Exclude<Verdict, "na">, string> = {
  strong: "Same invoice",
  maybe: "Same truck only",
  conflict: "Other invoice",
  none: "No link",
};

// Whether the reference trail ties this delivery to this invoice.
function verdictOf(ranked: RankedCandidate): Verdict {
  if (ranked.candidate.rejected) return "na";
  const by = (label: string) =>
    ranked.signals.find((signal) => signal.label === label)?.status;
  if (by("Invoice") === "different") return "conflict";
  if (
    by("Invoice") === "same" ||
    by("E-way bill") === "same" ||
    by("Lorry receipt") === "same"
  )
    return "strong";
  if (by("Vehicle") === "same") return "maybe";
  return "none";
}

const FIELD_NAME: Record<string, string> = {
  "PO reference": "PO",
  "Invoice No.": "Invoice no.",
  "E-Way Bill No.": "E-way bill",
  "Lorry Receipt No.": "Lorry receipt",
  "Vehicle No.": "Truck",
};
const TONE = {
  Matched: "same",
  "Partly matched": "part",
  Different: "diff",
  "Not checked": "unknown",
} as const;
const ICON_STYLE = {
  same: { background: "#e3f1e8", color: "#2c6a4f" },
  diff: { background: "#fbe7e5", color: "#b3261e" },
  part: { background: "#fdf1dc", color: "#8a5207" },
  unknown: { background: "#f0ece4", color: "#a49a8e" },
} as const;
const MARK = { same: "✓", diff: "≠", part: "~", unknown: "–" } as const;

const fmt = (value: number) => String(+Number(value).toFixed(3));
const shortDate = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
      })
    : "";

function Detail({
  ranked,
  verdict,
  invoice,
  ignorePo,
  service,
  amount,
}: {
  ranked: RankedCandidate;
  verdict: Verdict;
  invoice: MatchInvoice;
  ignorePo: boolean;
  service: boolean;
  amount: (value: number) => string;
}) {
  const { candidate } = ranked;
  if (verdict === "na")
    return (
      <div className="dt">
        <p className="dt-sum na">{candidate.rejected}</p>
      </div>
    );
  const rows = candidateEvidence(invoice, candidate);
  const proof = rows.filter((row) => row.label !== "PO reference");
  const names = (tone: string) =>
    proof
      .filter((row) => TONE[row.status] === tone)
      .map((row) => (FIELD_NAME[row.label] ?? row.label).toLowerCase());
  const list = (items: string[]) =>
    items.length > 1
      ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
      : items[0];
  const same = names("same");
  const diff = names("diff");
  const summary =
    verdict === "conflict"
      ? `Stores linked this delivery to invoice ${ranked.otherInvoice ?? "another invoice"}.`
      : [
          same.length
            ? `Confirmed by ${list(same)}`
            : "Nothing confirms this delivery",
          diff.length
            ? `${list(diff)} ${diff.length > 1 ? "are" : "is"} different`
            : "",
        ]
          .filter(Boolean)
          .join(" · ");
  const hint = (row: (typeof rows)[number]) =>
    ignorePo && row.label === "PO reference"
      ? "Invoice shows the supplier's order no., not a SAP PO"
      : row.note?.includes("part suffix")
        ? "Same invoice, part suffix"
        : row.note?.includes("Stores left this blank")
          ? "Not filled in by Stores"
          : "";
  return (
    <div className="dt">
      <p className={`dt-sum ${verdict}`}>{summary}</p>
      <div className="dt-grid" role="table">
        <div className="dt-h" role="row">
          <span role="columnheader" />
          <span role="columnheader">This invoice</span>
          <span role="columnheader">
            {service ? "PO" : "GRPO"} {candidate.docNum}
          </span>
        </div>
        {rows.map((row) => {
          const tone = TONE[row.status];
          return (
            <div className="dt-r" role="row" key={row.label}>
              <span className="dt-k" role="rowheader">
                {FIELD_NAME[row.label] ?? row.label}
              </span>
              <span className="dt-v mono" role="cell">
                {row.scanned}
              </span>
              <span className={`dt-v mono ${tone}`} role="cell">
                <span className="st-i" style={ICON_STYLE[tone]}>
                  {MARK[tone]}
                </span>
                <span>
                  {row.sap}
                  {hint(row) ? <small>{hint(row)}</small> : null}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      <dl className="dt-facts">
        <div>
          <dt>Received</dt>
          <dd>{amount(candidate.quantity)}</dd>
        </div>
        <div>
          <dt>Still open</dt>
          <dd>{amount(candidate.open)}</dd>
        </div>
        <div>
          <dt>Received on</dt>
          <dd>{formatDate(candidate.date)}</dd>
        </div>
      </dl>
    </div>
  );
}

export function ReceiptCandidatesPanel({
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [folds, setFolds] = useState<Set<string>>(new Set());
  const service = line.kind === "service";
  const label = service ? "POs" : SAP_TERMS.grpos;
  const selection = receiptSelection(line, locked ? {} : edits);
  const unitLabel = service ? "" : unit;
  const money = (value: number | null) =>
    value == null
      ? "—"
      : service
        ? inr(value)
        : `${fmt(value)}${unitLabel ? ` ${unitLabel}` : ""}`;
  const amount = (value: number) =>
    service ? inr(value) : `${qty(value)}${unitLabel ? ` ${unitLabel}` : ""}`;
  const hasErrors = Object.keys(selection.errors).length > 0;
  const ignorePo = !service && poNotOnInvoice(invoice, line.candidates);
  const ranked = rankCandidates(invoice, line.candidates, ignorePo);
  const verdictRank: Record<Verdict, number> = {
    strong: 0,
    maybe: 1,
    conflict: 2,
    none: 3,
    na: 4,
  };
  const rows = ranked
    .map((entry) => ({ entry, verdict: verdictOf(entry) }))
    .sort((a, b) => verdictRank[a.verdict] - verdictRank[b.verdict]);
  const query = search.trim().toLowerCase();
  type Row = (typeof rows)[number];
  const matches = ({ entry }: Row) =>
    !query ||
    [
      entry.candidate.docNum,
      entry.candidate.poRef,
      entry.candidate.vehicle,
      entry.candidate.date,
      entry.candidate.references?.invoice,
      entry.candidate.references?.eWayBill,
      entry.candidate.references?.lorryReceipt,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  // Groups follow the applied selection so rows never jump while editing.
  const applied = rows.filter(
    ({ entry }) => !entry.candidate.rejected && entry.candidate.allocated > 0,
  );
  const rest = rows.filter(({ entry }) => !(entry.candidate.allocated > 0));
  const groups: { key: string; title: string; xs: Row[]; fold?: boolean }[] = [
    { key: "in", title: "In this invoice", xs: applied },
    {
      key: "sug",
      title: "Suggested",
      xs: rest.filter(
        ({ verdict }) => verdict === "strong" || verdict === "maybe",
      ),
    },
    {
      key: "none",
      title: "No link to this invoice",
      xs: rest.filter(({ verdict }) => verdict === "none"),
      fold: true,
    },
    {
      key: "other",
      title: "Billed on other invoices",
      xs: rest.filter(({ verdict }) => verdict === "conflict"),
      fold: true,
    },
    {
      key: "na",
      title: "Not available",
      xs: rest.filter(({ verdict }) => verdict === "na"),
      fold: true,
    },
  ];
  const visible = groups
    .map((group) => ({ ...group, shown: group.xs.filter(matches) }))
    .filter((group) => group.shown.length);
  const hasMain = visible.some((group) => !group.fold);
  const firstFold = visible.find((group) => group.fold)?.key;

  const valueOf = (key: string, allocated: number) =>
    edits[key] ?? (allocated > 0 ? String(allocated) : "");
  const numberOf = (key: string, allocated: number) =>
    Number(valueOf(key, allocated)) || 0;
  const usage = (entry: RankedCandidate) => {
    const value = numberOf(entry.candidate.key, entry.candidate.allocated);
    return {
      pct:
        entry.candidate.open > 0
          ? Math.round((value / entry.candidate.open) * 100)
          : 0,
      over: !service && value > entry.candidate.open + 0.0005,
    };
  };
  const picked = ranked.filter(
    ({ candidate }) =>
      !candidate.rejected && numberOf(candidate.key, candidate.allocated) > 0,
  );
  const colorOf = (entry: RankedCandidate) => {
    const index = picked.indexOf(entry);
    return index < 0 ? "transparent" : SEG_COLORS[index % SEG_COLORS.length];
  };
  const remaining = Math.max(0, selection.remaining ?? 0);
  const setValue = (key: string, next: string) =>
    setEdits((current) => ({ ...current, [key]: next }));
  const pickService = (key: string) =>
    setEdits(
      Object.fromEntries(
        line.candidates
          .filter((candidate) => !candidate.rejected)
          .map((option) => [
            option.key,
            option.key === key ? String(line.invoiceAmount ?? 0) : "0",
          ]),
      ),
    );
  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  };

  const billed = selection.billed;
  const balanced =
    selection.remaining != null && Math.abs(selection.remaining) < 0.0005;
  const overRow = ranked.find(
    (entry) => !entry.candidate.rejected && usage(entry).over,
  );
  const meterStatus: "ok" | "over" | "short" = locked
    ? "ok"
    : overRow || (selection.remaining ?? 0) < 0
      ? "over"
      : balanced
        ? "ok"
        : "short";
  const meterLabel = locked
    ? "Saved comparison"
    : overRow
      ? `GRPO ${overRow.candidate.docNum} has only ${money(overRow.candidate.open)} open`
      : selection.remaining == null
        ? "Invoice amount unavailable"
        : meterStatus === "over"
          ? `${money(-selection.remaining)} too much`
          : meterStatus === "ok"
            ? "Adds up"
            : `${money(selection.remaining)} to cover`;
  const scale = Math.max(billed ?? 0, selection.total) || 1;
  const footMessage = locked
    ? "Read-only · quantities from the saved comparison, not current SAP balances."
    : overRow
      ? `Reduce ${service ? "PO" : "GRPO"} ${overRow.candidate.docNum} to ${money(overRow.candidate.open)} or less`
      : hasErrors
        ? "Correct the highlighted quantities"
        : !selection.dirty
          ? "No changes"
          : selection.remaining == null
            ? "Review the invoice amount"
            : balanced
              ? "Ready to apply"
              : selection.remaining < 0
                ? "More than the invoice bills"
                : "Invoice not fully covered";

  const renderRow = ({ entry, verdict }: Row) => {
    const { candidate } = entry;
    const value = valueOf(candidate.key, candidate.allocated);
    const used = numberOf(candidate.key, candidate.allocated);
    const isPicked = used > 0;
    const isOpen = expanded.has(candidate.key);
    const use = usage(entry);
    const na = verdict === "na";
    const unitSuffix = unitLabel ? ` ${unitLabel}` : "";
    const error = selection.errors[candidate.key];
    const note = use.over
      ? `More than this delivery has open (${fmt(candidate.open)}${unitSuffix}).`
      : !service && isPicked && used < candidate.open - 0.0005
        ? `Part delivery · ${fmt(used)} of ${fmt(candidate.open)}${unitSuffix} · ${fmt(candidate.open - used)}${unitSuffix} stays open for a later invoice`
        : "";
    const why =
      verdict === "strong"
        ? "Same invoice"
        : verdict === "maybe"
          ? "Same truck only, nothing else confirms it"
          : verdict === "conflict"
            ? `Stores tagged it to invoice ${entry.otherInvoice}`
            : verdict === "none"
              ? "Nothing links it to this invoice"
              : (candidate.rejected ?? "");
    return (
      <li
        key={candidate.key}
        className={`gr ${isPicked ? "picked" : ""} ${isOpen ? "open" : ""} v-${verdict}`}
        style={{ "--seg": colorOf(entry) } as CSSProperties}
      >
        <div className="gr-main">
          {locked ? (
            <span
              className={`gr-check ${isPicked ? "on" : ""}`}
              aria-hidden="true"
            >
              {isPicked ? <Check strokeWidth={3} /> : null}
            </span>
          ) : na ? (
            <span className="gr-check na" aria-hidden="true" />
          ) : (
            <button
              type="button"
              className={`gr-check ${isPicked ? "on" : ""}`}
              role="checkbox"
              aria-checked={isPicked}
              aria-label={`Use ${service ? "PO" : "GRPO"} ${candidate.docNum}`}
              disabled={busy}
              onClick={() => {
                if (service) return pickService(candidate.key);
                const fill =
                  Math.round(Math.min(candidate.open, remaining) * 1000) / 1000;
                setValue(
                  candidate.key,
                  isPicked ? "0" : String(fill > 0 ? fill : candidate.open),
                );
              }}
            >
              <Check strokeWidth={3} />
            </button>
          )}
          <button
            type="button"
            className="gr-body"
            aria-expanded={isOpen}
            title={why}
            onClick={() =>
              setExpanded((current) => toggle(current, candidate.key))
            }
          >
            <span className="gr-id">
              <b>{candidate.docNum}</b>
              <small>
                {candidate.poRef ? `PO ${candidate.poRef} · ` : ""}
                Received {shortDate(candidate.date)}
              </small>
            </span>
            <span className="gr-truck mono">{candidate.vehicle || "—"}</span>
            {na ? (
              <span className="gr-na">{candidate.rejected}</span>
            ) : (
              <span className={`verdict ${verdict}`}>
                {VERDICT_LABEL[verdict as Exclude<Verdict, "na">]}
              </span>
            )}
            <span className="gr-chev">
              <ChevronRight />
            </span>
          </button>
          {locked && isPicked ? (
            <span className="gr-qty">
              <span className="num">{amount(candidate.allocated)}</span>
              <small>used</small>
            </span>
          ) : isPicked && !service ? (
            <span className="gr-qty picked">
              <span className="gr-alloc">
                <input
                  className={`gr-input num ${use.over || error ? "over" : ""}`}
                  inputMode="decimal"
                  disabled={busy}
                  value={value}
                  onChange={(event) =>
                    setValue(candidate.key, event.target.value)
                  }
                  aria-label={`Quantity from GRPO ${candidate.docNum}, ${fmt(candidate.open)}${unitSuffix} open`}
                  aria-invalid={Boolean(error)}
                />
                <small>of {fmt(candidate.open)}</small>
              </span>
              <span
                className={`gr-use ${use.over ? "over" : ""}`}
                title={`Using ${use.pct}% of what this GRPO has open`}
              >
                <span style={{ width: `${Math.min(100, use.pct)}%` }} />
              </span>
            </span>
          ) : (
            <span className="gr-qty">
              <span className="num">
                {service ? inr(candidate.open) : fmt(candidate.open)}
              </span>
              <small>{service ? "open" : `${unitLabel || "qty"} open`}</small>
            </span>
          )}
        </div>
        <div className={`gr-note ${use.over || error ? "error" : ""}`}>
          {error ?? note}
        </div>
        {isOpen ? (
          <Detail
            ranked={entry}
            verdict={verdict}
            invoice={invoice}
            ignorePo={ignorePo}
            service={service}
            amount={amount}
          />
        ) : null}
      </li>
    );
  };

  const heading = locked
    ? "Deliveries this invoice paid for"
    : "Which deliveries does this invoice pay for?";
  const discard = () => {
    setEdits({});
    setOpen(false);
  };

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
        <DialogOverlay className="bg-[rgba(28,20,14,0.28)] backdrop-blur-none" />
        <DialogContent className="gd fixed inset-y-0 right-0 z-50 flex h-dvh w-full max-w-[640px] flex-col bg-white shadow-[-24px_0_48px_rgba(43,26,16,0.14)] outline-none duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right motion-reduce:animate-none">
          <header className="v3-head">
            <div className="v3-top">
              <div>
                <DialogDescription className="eyebrow">
                  {title}
                  {line.itemCode ? ` · ${line.itemCode}` : ""} · invoice line{" "}
                  {line.index + 1}
                </DialogDescription>
                <DialogTitle asChild>
                  <h2>{heading}</h2>
                </DialogTitle>
              </div>
              <DialogClose className="icon-btn" aria-label="Close">
                <X size={16} />
              </DialogClose>
            </div>
            <div className="meter">
              <div className="m-row">
                <span className="m-big num">
                  {service ? inr(selection.total) : fmt(selection.total)}
                  <span>
                    {" "}
                    /{" "}
                    {billed == null ? "—" : service ? inr(billed) : fmt(billed)}
                    {unitLabel ? ` ${unitLabel}` : ""}
                  </span>
                </span>
                <span className={`m-state ${meterStatus}`}>
                  {meterStatus === "ok" ? <Check /> : null}
                  {meterLabel}
                </span>
              </div>
              <div className="seg">
                {picked.map((entry, index) => {
                  const part = numberOf(
                    entry.candidate.key,
                    entry.candidate.allocated,
                  );
                  return (
                    <span
                      key={entry.candidate.key}
                      title={`${service ? "PO" : "GRPO"} ${entry.candidate.docNum} · ${fmt(part)}`}
                      style={{
                        flexBasis: `${(part / scale) * 100}%`,
                        background: SEG_COLORS[index % SEG_COLORS.length],
                      }}
                    />
                  );
                })}
              </div>
              <div className="seg-legend">
                {picked.length ? (
                  picked.map((entry, index) => (
                    <span key={entry.candidate.key}>
                      <i
                        style={{
                          background: SEG_COLORS[index % SEG_COLORS.length],
                        }}
                      />
                      {entry.candidate.docNum}
                      <b>
                        {fmt(
                          numberOf(
                            entry.candidate.key,
                            entry.candidate.allocated,
                          ),
                        )}
                      </b>
                    </span>
                  ))
                ) : (
                  <span>No delivery picked</span>
                )}
              </div>
            </div>
            <label className="v3-search">
              <Search size={15} />
              <input
                aria-label={`Search considered ${label}`}
                placeholder="Find by GRPO, truck, e-way bill or invoice no."
                autoComplete="off"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </header>
          <div className="v3-body">
            {visible.length ? (
              <>
                <div className="cols" aria-hidden="true">
                  <span />
                  <span>{service ? "PO" : "GRPO"}</span>
                  <span>Truck</span>
                  <span>Match</span>
                  <span />
                  <span className="cols-qty">{unitLabel || "Qty"}</span>
                </div>
                {visible.map((group) => {
                  const isOpen =
                    !group.fold ||
                    Boolean(query) ||
                    folds.has(group.key) ||
                    (!hasMain &&
                      group.key === firstFold &&
                      !folds.has("x:" + group.key));
                  const canExpandAll =
                    group.shown.length > 1 &&
                    (group.key === "in" ||
                      (group.key === "sug" && group.shown.length <= 5));
                  const allOpen = group.shown.every(({ entry }) =>
                    expanded.has(entry.candidate.key),
                  );
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
                            const auto =
                              !hasMain &&
                              group.key === firstFold &&
                              !folds.has(group.key);
                            setFolds((current) =>
                              toggle(
                                current,
                                auto && isOpen ? "x:" + group.key : group.key,
                              ),
                            );
                          }}
                        >
                          {group.fold ? (
                            <span
                              className={`grp-chev ${isOpen ? "down" : ""}`}
                            >
                              <ChevronRight />
                            </span>
                          ) : null}
                          <span>{group.title}</span>
                          <span className="grp-count">
                            {group.shown.length}
                          </span>
                        </button>
                        {canExpandAll ? (
                          <button
                            type="button"
                            className="grp-all"
                            onClick={() =>
                              setExpanded((current) => {
                                const next = new Set(current);
                                for (const { entry } of group.shown) {
                                  if (allOpen) next.delete(entry.candidate.key);
                                  else next.add(entry.candidate.key);
                                }
                                return next;
                              })
                            }
                          >
                            {allOpen ? "Hide details" : "Show details"}
                          </button>
                        ) : null}
                      </div>
                      {isOpen ? (
                        <ul className="gr-list">
                          {group.shown.map(renderRow)}
                        </ul>
                      ) : null}
                    </section>
                  );
                })}
              </>
            ) : (
              <p className="empty">
                {query
                  ? `No delivery matches “${search}”.`
                  : "No eligible candidates available."}
              </p>
            )}
          </div>
          <footer className="v3-foot">
            <span
              role="status"
              aria-live="polite"
              className={`f-msg ${overRow || hasErrors ? "error" : selection.dirty && !balanced ? "warn" : ""}`}
            >
              {footMessage}
            </span>
            {!locked && (line.manual || Object.keys(edits).length) ? (
              <button
                type="button"
                className="btn ghost"
                disabled={busy}
                onClick={() => {
                  setEdits({});
                  if (line.manual) onResetAllocation(line.index);
                }}
              >
                Restore automatic
              </button>
            ) : null}
            <button type="button" className="btn ghost" onClick={discard}>
              {selection.dirty && !locked ? "Discard" : "Close"}
            </button>
            {!locked ? (
              <button
                type="button"
                className="btn primary"
                disabled={
                  busy || !selection.dirty || hasErrors || Boolean(overRow)
                }
                onClick={() => {
                  if (busy || hasErrors || !selection.dirty) return;
                  onAllocate(line.index, selection.allocations);
                  setEdits({});
                  setOpen(false);
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
