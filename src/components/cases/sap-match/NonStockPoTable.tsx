"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
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
import {
  NonStockPoDrawer,
  confirmedPoCandidate,
  poCandidatesOf as candidatesOf,
  poLineTitle,
} from "./NonStockPoDrawer";

function Row({
  invoice,
  line,
  busy,
  locked,
  onOpen,
}: {
  invoice: MatchInvoice;
  line: LineResult;
  busy: boolean;
  locked: boolean;
  onOpen: () => void;
}) {
  const source = invoice.lines.find((entry) => entry.index === line.index);
  const update = useMatchUpdate(line.index);
  const saving = Boolean(update && update.phase !== "failed");
  const confirmed = confirmedPoCandidate(line);
  return (
    <tr className="border-b border-[#f0ece4] align-top last:border-b-0">
      <td className="px-3 py-2 text-[#8a7f72]">{line.index + 1}</td>
      <td className="px-3 py-2">
        <span className="block font-medium text-[#111827]">
          {source?.description || `Invoice line ${line.index + 1}`}
        </span>
        <span className="block tabular-nums text-[#6b5d50]">
          {qty(line.invoiceQty)} × {inr(line.invoiceRate)} ={" "}
          {inr(line.invoiceAmount)}
        </span>
        <MatchUpdateNotice lineIndex={line.index} />
      </td>
      <td className="px-3 py-2">
        <span className="flex flex-wrap items-center gap-2">
          {confirmed ? (
            <span className="font-medium text-[#24583e]">
              ✓ PO {confirmed.docNum} · Line {(confirmed.lineNum ?? 0) + 1} ·{" "}
              {poLineTitle(confirmed)}
            </span>
          ) : null}
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#d4c9bc] bg-[#fcfbf9] px-2.5 py-1 text-[11px] font-medium text-[#5d422e] hover:bg-[#f0ece4] disabled:opacity-50"
            disabled={busy || saving}
            onClick={onOpen}
          >
            {locked ? "View PO line" : confirmed ? "Change" : "Choose PO line"}
            <ChevronRight className="h-3 w-3" />
          </button>
        </span>
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
  const [drawerLine, setDrawerLine] = useState<number | null>(null);
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
          Choose the PO line for each invoice line
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
          <div className="space-y-2">
            <div className="overflow-x-auto rounded-lg border border-[#e0d8cc]">
              <table className="w-full min-w-[520px] text-left text-[11px]">
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
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <Row
                      key={line.index}
                      invoice={invoice}
                      line={line}
                      busy={busy}
                      locked={locked}
                      onOpen={() => setDrawerLine(line.index)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            {currentPo
              ? lines
                  .filter((line) => line.index === drawerLine)
                  .map((line) => (
                    <NonStockPoDrawer
                      key={line.index}
                      open
                      onOpenChange={(next) => !next && setDrawerLine(null)}
                      invoice={invoice}
                      line={line}
                      lines={lines}
                      poDocEntry={currentPo.docEntry}
                      poLabel={poText(currentPo)}
                      busy={busy}
                      locked={locked}
                      onAllocate={onAllocate}
                      onReset={onResetAllocation}
                      position={{
                        number: lines.indexOf(line) + 1,
                        count: lines.length,
                      }}
                      onPrev={
                        lines.indexOf(line) > 0
                          ? () =>
                              setDrawerLine(
                                lines[lines.indexOf(line) - 1].index,
                              )
                          : undefined
                      }
                      onNext={
                        lines.indexOf(line) < lines.length - 1
                          ? () =>
                              setDrawerLine(
                                lines[lines.indexOf(line) + 1].index,
                              )
                          : undefined
                      }
                      moreToDo={lines.some(
                        (other) =>
                          other.index !== line.index &&
                          !confirmedPoCandidate(other),
                      )}
                      onApplied={() => {
                        const order = [
                          ...lines.slice(lines.indexOf(line) + 1),
                          ...lines.slice(0, lines.indexOf(line)),
                        ];
                        const next = order.find(
                          (other) => !confirmedPoCandidate(other),
                        );
                        setDrawerLine(next ? next.index : null);
                      }}
                    />
                  ))
              : null}
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
