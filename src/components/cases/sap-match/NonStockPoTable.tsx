"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  needsNonStockPoConfirmation,
  nonStockPoReferenceMatches,
} from "@/lib/sap-match/non-stock-po-review";
import type {
  CandidateView,
  LineResult,
  MatchCheck,
  MatchInvoice,
} from "@/lib/sap-match/types";
import { CheckBlock } from "./CheckBlock";
import { formatDate, inr, qty } from "./format";
import { ItemLinker } from "./ItemLinker";
import { MatchUpdateNotice, useMatchUpdate } from "./MatchUpdateContext";
import { factsFor } from "./ServicePoCandidates";

const EPSILON = 0.005;

function candidatesOf(line: LineResult) {
  return (
    line.kind === "unmapped"
      ? (line.nonStockPoCandidates ?? [])
      : line.candidates
  ).filter(
    (candidate) =>
      candidate.kind === "PO" && candidate.documentType === "dDocument_Items",
  );
}

function lineTitle(candidate: CandidateView) {
  return (
    candidate.poEvidence?.lineRemarks ||
    candidate.poEvidence?.description ||
    candidate.itemName ||
    "No description"
  );
}

function optionLabel(candidate: CandidateView) {
  return `Line ${(candidate.lineNum ?? 0) + 1} · ${lineTitle(candidate)} · ${qty(candidate.poEvidence?.openQuantity)} × ${inr(candidate.price)}`;
}

/** Exact quantity and price: a stated fact used only to group the choices, never to pick one. */
function fits(line: LineResult, candidate: CandidateView) {
  return (
    line.invoiceQty != null &&
    line.invoiceRate != null &&
    candidate.poEvidence?.openQuantity != null &&
    candidate.price != null &&
    Math.abs(line.invoiceQty - candidate.poEvidence.openQuantity) < EPSILON &&
    Math.abs(line.invoiceRate - candidate.price) < EPSILON
  );
}

function Row({
  invoice,
  line,
  pool,
  picked,
  onPick,
  claimedElsewhere,
  busy,
  locked,
  onAllocate,
  onResetAllocation,
}: {
  invoice: MatchInvoice;
  line: LineResult;
  pool: CandidateView[];
  picked: string;
  onPick: (key: string) => void;
  claimedElsewhere: (key: string) => number;
  busy: boolean;
  locked: boolean;
  onAllocate: (index: number, allocations: Record<string, number>) => void;
  onResetAllocation: (index: number) => void;
}) {
  const source = invoice.lines.find((entry) => entry.index === line.index);
  const update = useMatchUpdate(line.index);
  const saving = Boolean(update && update.phase !== "failed");
  const confirmed = line.candidates.find(
    (candidate) => candidate.kind === "PO" && candidate.allocated > 0,
  );
  const chosen =
    confirmed ?? pool.find((candidate) => candidate.key === picked);
  const amount = line.invoiceAmount;
  const facts = chosen
    ? factsFor(chosen, source, amount).facts.filter(
        (fact) => fact.tone !== "ok" && !fact.text.startsWith("Item code"),
      )
    : [];
  const left = chosen ? (chosen.open ?? 0) - claimedElsewhere(chosen.key) : 0;
  const overdrawn = Boolean(
    chosen && !confirmed && (amount ?? 0) > left + EPSILON,
  );
  const fitting = pool.filter((candidate) => fits(line, candidate));
  const others = pool.filter((candidate) => !fits(line, candidate));
  const option = (candidate: CandidateView) => (
    <option
      key={candidate.key}
      value={candidate.key}
      disabled={Boolean(candidate.rejected)}
    >
      {optionLabel(candidate)}
      {candidate.rejected ? " · not available" : ""}
    </option>
  );
  return (
    <tr className="border-b border-[#f0ece4] align-top last:border-b-0">
      <td className="px-3 py-2 text-[#8a7f72]">{line.index + 1}</td>
      <td className="px-3 py-2">
        <span className="block font-medium text-[#111827]">
          {source?.description || `Invoice line ${line.index + 1}`}
        </span>
        <span className="block tabular-nums text-[#6b5d50]">
          {qty(line.invoiceQty)} × {inr(line.invoiceRate)} = {inr(amount)}
        </span>
        <MatchUpdateNotice lineIndex={line.index} />
      </td>
      <td className="px-3 py-2">
        {confirmed ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-[#24583e]">
              ✓ PO {confirmed.docNum} · Line {(confirmed.lineNum ?? 0) + 1} ·{" "}
              {lineTitle(confirmed)}
            </span>
            {!locked ? (
              <button
                type="button"
                className="underline disabled:opacity-50"
                disabled={busy || saving}
                onClick={() => onResetAllocation(line.index)}
              >
                Change
              </button>
            ) : null}
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            <select
              aria-label={`PO line for invoice line ${line.index + 1}`}
              className="min-w-[16rem] max-w-full rounded-md border border-[#e0d8cc] bg-white p-1.5"
              value={picked}
              disabled={busy || locked || saving || !amount}
              onChange={(event) => onPick(event.target.value)}
            >
              <option value="">Choose a PO line</option>
              {fitting.length ? (
                <optgroup label="Same quantity and price">
                  {fitting.map(option)}
                </optgroup>
              ) : null}
              {others.length ? (
                <optgroup label={fitting.length ? "Other lines" : "PO lines"}>
                  {others.map(option)}
                </optgroup>
              ) : null}
            </select>
            {picked && !overdrawn ? (
              <Button
                type="button"
                size="sm"
                className="h-7 px-2.5 text-[11px]"
                disabled={busy || locked || saving}
                onClick={() => onAllocate(line.index, { [picked]: amount! })}
              >
                Confirm
              </Button>
            ) : null}
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        {overdrawn ? (
          <span className="text-[#b3261e]">
            Only {inr(Math.max(left, 0))} left on this PO line
          </span>
        ) : chosen && !facts.length ? (
          <span className="text-[#3d5a47]">✓ Quantity and price</span>
        ) : (
          facts.map((fact) => (
            <span
              key={fact.text}
              className={`block ${fact.tone === "bad" ? "text-[#b3261e]" : "text-[#8a5207]"}`}
            >
              {fact.text}
            </span>
          ))
        )}
      </td>
    </tr>
  );
}

/** One table for the whole invoice: the user picks a PO line per invoice line. */
export function NonStockPoTable({
  caseId,
  invoice,
  lines,
  checks,
  busy,
  locked,
  onChoose,
  onUndo,
  onAllocate,
  onResetAllocation,
  onLink,
}: {
  caseId: string;
  invoice: MatchInvoice;
  lines: LineResult[];
  checks: MatchCheck[];
  busy: boolean;
  locked: boolean;
  onChoose: (check: MatchCheck, choice: string, reason: string) => void;
  onUndo: (check: MatchCheck) => void;
  onAllocate: (index: number, allocations: Record<string, number>) => void;
  onResetAllocation: (index: number) => void;
  onLink: (line: LineResult, itemCode: string) => void;
}) {
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [changingPo, setChangingPo] = useState(false);
  const pending = lines.filter((line) =>
    needsNonStockPoConfirmation(invoice, line),
  );
  const allPool = [
    ...new Map(
      lines
        .flatMap(candidatesOf)
        .map((candidate) => [candidate.key, candidate]),
    ).values(),
  ];
  const pos = [
    ...new Map(
      allPool.map((candidate) => [candidate.docEntry, candidate]),
    ).values(),
  ];
  const cited = pos.filter((po) =>
    nonStockPoReferenceMatches(invoice.poReferences, [
      po.docNum,
      ...(po.references?.po ?? []),
    ]),
  );
  const confirmedPo = lines
    .flatMap((line) => line.candidates)
    .find((candidate) => candidate.kind === "PO" && candidate.allocated > 0);
  const [poChoice, setPoChoice] = useState(
    confirmedPo
      ? String(confirmedPo.docEntry)
      : cited.length === 1
        ? String(cited[0].docEntry)
        : "",
  );
  const poLeft = (docEntry: number) =>
    allPool
      .filter((candidate) => candidate.docEntry === docEntry)
      .reduce((sum, candidate) => sum + (candidate.open ?? 0), 0);
  const poText = (po: CandidateView) =>
    `PO ${po.docNum} · ${formatDate(po.date)} · ${inr(poLeft(po.docEntry))} left`;
  const currentPo = pos.find((po) => String(po.docEntry) === poChoice);
  const confirmedCount = lines.length - pending.length;
  const total = lines.reduce((sum, line) => sum + (line.invoiceAmount ?? 0), 0);
  const confirmedTotal = lines
    .filter((line) => !pending.includes(line))
    .reduce((sum, line) => sum + (line.invoiceAmount ?? 0), 0);
  /** What other invoice lines have already confirmed or picked on the same PO line. */
  const claimedElsewhere = (line: LineResult) => (key: string) =>
    lines.reduce((sum, other) => {
      if (other.index === line.index) return sum;
      const confirmed = other.candidates.some(
        (candidate) => candidate.key === key && candidate.allocated > 0,
      );
      return confirmed || picks[other.index] === key
        ? sum + (other.invoiceAmount ?? 0)
        : sum;
    }, 0);
  const openChecks = checks.filter(
    (check) => !check.id.startsWith("map-") && (check.open || check.decision),
  );
  const unlinked = pending
    .map((line) => ({
      line,
      check: checks.find((check) => check.id === `map-${line.index}`),
    }))
    .filter((entry) => entry.check);

  return (
    <section
      aria-label="Confirm PO lines"
      className="overflow-hidden rounded-xl border border-[#e0d8cc] bg-white"
    >
      <header className="space-y-0.5 border-b border-[#ece6dc] px-4 py-3">
        <h3 className="text-[13px] font-semibold text-[#111827]">
          Confirm the PO line for each invoice line
        </h3>
        <p className="text-[11px] text-[#6b5d50]">
          SAP lists these PO items as non-stock. Nothing is chosen for you.
        </p>
      </header>
      <div className="space-y-3 px-4 py-3 text-[11px]">
        {pos.length > 1 && (changingPo || !currentPo) ? (
          <label className="flex flex-wrap items-center gap-2 font-medium text-[#3d3530]">
            SAP PO
            <select
              className="min-w-[18rem] max-w-full rounded-md border border-[#e0d8cc] bg-white p-1.5 font-normal"
              value={poChoice}
              disabled={confirmedCount > 0}
              onChange={(event) => {
                setPoChoice(event.target.value);
                setPicks({});
                setChangingPo(false);
              }}
            >
              <option value="">Choose a PO ({pos.length} supplier POs)</option>
              {cited.length ? (
                <optgroup label="Cited on the invoice">
                  {cited.map((po) => (
                    <option key={po.docEntry} value={String(po.docEntry)}>
                      {poText(po)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              <optgroup label={cited.length ? "Other open POs" : "Open POs"}>
                {pos
                  .filter((po) => !cited.includes(po))
                  .map((po) => (
                    <option key={po.docEntry} value={String(po.docEntry)}>
                      {poText(po)}
                    </option>
                  ))}
              </optgroup>
            </select>
          </label>
        ) : currentPo ? (
          <p className="text-[#3d3530]">
            <strong className="font-semibold text-[#111827]">
              {poText(currentPo)}
            </strong>
            {cited.some((po) => po.docEntry === currentPo.docEntry)
              ? " · cited on the invoice"
              : ""}
            {pos.length > 1 && !confirmedCount ? (
              <>
                {" · "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => setChangingPo(true)}
                >
                  Change PO
                </button>
              </>
            ) : null}
          </p>
        ) : null}

        {poChoice ? (
          <div className="overflow-x-auto rounded-lg border border-[#e0d8cc]">
            <table className="w-full min-w-[640px] text-left text-[11px]">
              <thead>
                <tr className="border-b border-[#ece6dc] bg-[#faf8f4] text-[10px] font-medium uppercase tracking-wider text-[#8a7f72]">
                  <th scope="col" className="w-8 px-3 py-1.5">
                    #
                  </th>
                  <th scope="col" className="px-3 py-1.5">
                    Invoice line
                  </th>
                  <th scope="col" className="px-3 py-1.5">
                    PO line
                  </th>
                  <th scope="col" className="w-48 px-3 py-1.5">
                    Check
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <Row
                    key={line.index}
                    invoice={invoice}
                    line={line}
                    pool={candidatesOf(line).filter(
                      (candidate) => String(candidate.docEntry) === poChoice,
                    )}
                    picked={picks[line.index] ?? ""}
                    onPick={(key) =>
                      setPicks((current) => ({ ...current, [line.index]: key }))
                    }
                    claimedElsewhere={claimedElsewhere(line)}
                    busy={busy}
                    locked={locked}
                    onAllocate={(index, allocations) => {
                      onAllocate(index, allocations);
                      setPicks((current) => {
                        const next = { ...current };
                        delete next[index];
                        return next;
                      });
                    }}
                    onResetAllocation={onResetAllocation}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[#6b5d50]">Choose the SAP PO to see its lines.</p>
        )}

        <p className="tabular-nums text-[#6b5d50]">
          Invoice {inr(total)} · confirmed {inr(confirmedTotal)} ·{" "}
          {pending.length
            ? `${pending.length} of ${lines.length} lines left`
            : "all lines confirmed"}
        </p>

        {openChecks.map((check) => (
          <CheckBlock
            key={check.id}
            check={check}
            busy={busy}
            locked={locked}
            onChoose={(choice, reason) => onChoose(check, choice, reason)}
            onUndo={() => onUndo(check)}
          />
        ))}

        {unlinked.length ? (
          <details className="text-[#6b5d50]">
            <summary className="cursor-pointer font-medium text-[#6b4a33]">
              A line is not on this PO?
            </summary>
            <div className="mt-2 space-y-3">
              {unlinked.map(({ line, check }) => (
                <div key={line.index}>
                  <p className="mb-1 font-medium text-[#3d3530]">
                    Invoice line {line.index + 1}
                  </p>
                  <ItemLinker
                    caseId={caseId}
                    check={check!}
                    canLink
                    busy={busy || locked}
                    onLink={(itemCode) => onLink(line, itemCode)}
                  />
                </div>
              ))}
            </div>
          </details>
        ) : null}

        {invoice.source?.fileName ? (
          <p className="text-[10px] text-[#8a7f72]">
            Invoice source: {invoice.source.fileName} ·{" "}
            {invoice.source.pageLabel || "PDF"}
          </p>
        ) : null}
      </div>
    </section>
  );
}
