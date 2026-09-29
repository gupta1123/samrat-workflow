"use client";

import { useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  CandidateView,
  LineResult,
  MatchCheck,
  MatchInvoice,
} from "@/lib/sap-match/types";
import { CheckBlock } from "./CheckBlock";
import { formatDate, inr, qty } from "./format";
import { ItemLinker } from "./ItemLinker";

type Tone = "ok" | "warn" | "bad" | "wait";

const TONE_TEXT: Record<Tone, string> = {
  ok: "text-[#111827]",
  warn: "text-[#9a5a0a]",
  bad: "text-[#b3261e]",
  wait: "text-[#5c5650]",
};

function toneOf(checks: MatchCheck[], ids: string[]): Tone {
  const relevant = checks.filter((check) => ids.includes(check.id) && check.open);
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
}: {
  label: string;
  order: string;
  received: string;
  billed: string;
  tone: Tone;
}) {
  return (
    <tr className="border-t border-[#f0ece4]">
      <td className="py-2 pr-3 text-[#8a7f72]">{label}</td>
      <td className="py-2 pr-3 tabular-nums text-[#111827]">{order}</td>
      <td className="py-2 pr-3 tabular-nums text-[#111827]">{received}</td>
      <td className={`py-2 tabular-nums font-semibold ${TONE_TEXT[tone]}`}>{billed}</td>
    </tr>
  );
}

function CandidateRow({
  candidate,
  service,
  manual,
  value,
  onValue,
  locked,
}: {
  candidate: CandidateView;
  service: boolean;
  manual: boolean;
  value: string;
  onValue: (next: string) => void;
  locked: boolean;
}) {
  const rejected = Boolean(candidate.rejected);
  return (
    <li className={`px-3 py-2.5 ${rejected ? "bg-[#faf8f4] text-[#8a7f72]" : ""}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold text-[#111827]">
            {service ? "PO" : "Receipt"} {candidate.docNum}
            <span className="ml-2 font-normal text-[#8a7f72]">
              {formatDate(candidate.date)}
              {candidate.poRef ? ` · PO ${candidate.poRef}` : ""}
              {candidate.vehicle ? ` · ${candidate.vehicle}` : ""}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] leading-4">
            {rejected ? (
              <span className="text-[#b3261e]">Not used: {candidate.rejected}</span>
            ) : (
              <>
                {candidate.good.length ? (
                  <span className="text-[#2c6a4f]">{candidate.good.join(" · ")}</span>
                ) : null}
                {candidate.bad.length ? (
                  <span className="text-[#9a5a0a]">
                    {candidate.good.length ? " · " : ""}
                    {candidate.bad.join(" · ")}
                  </span>
                ) : null}
              </>
            )}
            {candidate.note ? <span className="text-[#8a7f72]"> · {candidate.note}</span> : null}
          </div>
        </div>
        <div className="text-right text-[10px] tabular-nums text-[#6b5d50]">
          <div>{service ? `${inr(candidate.open)} left` : `${qty(candidate.open)} open`}</div>
          {!rejected ? <div>fit {candidate.score}%</div> : null}
        </div>
        {!rejected && !locked ? (
          service ? (
            <label className="flex items-center gap-1 text-[10px] text-[#3d3530]">
              <input
                type="radio"
                name={`svc-${candidate.docEntry}`}
                checked={candidate.allocated > 0}
                onChange={() => onValue("use")}
              />
              Use
            </label>
          ) : (
            <input
              aria-label={`Quantity from receipt ${candidate.docNum}`}
              className={`h-7 w-20 rounded-md border px-2 text-right text-[11px] tabular-nums outline-none focus:border-[#2d6a4f] ${manual ? "border-[#2d6a4f]" : "border-[#cfc4b8]"}`}
              inputMode="decimal"
              value={value}
              onChange={(event) => onValue(event.target.value)}
            />
          )
        ) : null}
      </div>
    </li>
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
  const [showReceipts, setShowReceipts] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const service = line.kind === "service";
  const unmapped = line.kind === "unmapped";
  const selected = line.candidates.filter((candidate) => candidate.allocated > 0);
  const received = selected.reduce((total, candidate) => total + candidate.open, 0);
  const title = invoiceLine?.description || invoiceLine?.vendorItemCode || `Line ${line.index + 1}`;
  const mapCheck = checks.find((check) => check.id === `map-${line.index}`);
  const others = checks.filter((check) => check.id !== `map-${line.index}` && (check.open || check.decision));
  const dirty = Object.keys(edits).length > 0;

  const valueOf = (candidate: CandidateView) =>
    edits[candidate.key] ?? (candidate.allocated > 0 ? String(candidate.allocated) : "");

  function apply() {
    const allocations: Record<string, number> = {};
    for (const candidate of line.candidates) {
      if (candidate.rejected) continue;
      const raw = edits[candidate.key];
      const value = raw !== undefined ? Number(raw) : candidate.allocated;
      if (Number.isFinite(value) && value > 0) allocations[candidate.key] = value;
    }
    onAllocate(line.index, allocations);
    setEdits({});
  }

  const rateDelta =
    !service && line.po?.rate != null && line.invoiceRate != null ? line.invoiceRate - line.po.rate : null;

  return (
    <section className="overflow-hidden rounded-xl border border-[#e0d8cc] bg-white shadow-[0_1px_2px_rgba(43,26,16,0.04)]">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[#ece6dc] px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold text-[#111827]" title={title}>
            {title}
          </div>
          <div className="mt-0.5 text-[10px] text-[#8a7f72]">
            {invoiceLine?.vendorItemCode ? <span className="font-mono">{invoiceLine.vendorItemCode}</span> : null}
            {line.itemCode ? (
              <>
                {invoiceLine?.vendorItemCode ? " → " : ""}
                <span className="font-mono">{line.itemCode}</span>
                {line.itemName ? ` · ${line.itemName}` : ""}
              </>
            ) : null}
            {!unmapped ? ` · ${service ? "service, 2-way check" : "stock item, 3-way check"}` : ""}
          </div>
        </div>
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
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-[#b3a899]">
                  <th className="w-24 pb-1 font-semibold" />
                  <th className="pb-1 font-semibold">Ordered (PO)</th>
                  <th className="pb-1 font-semibold">Received</th>
                  <th className="pb-1 font-semibold">Billed</th>
                </tr>
              </thead>
              <tbody>
                {service ? (
                  <Row
                    label="Amount"
                    order={selected[0] ? `${inr(selected[0].open)} left` : "—"}
                    received="Not needed"
                    billed={inr(line.invoiceAmount)}
                    tone={toneOf(checks, [`amt-${line.index}`, `rcpt-${line.index}`])}
                  />
                ) : (
                  <>
                    <Row
                      label="Quantity"
                      order={line.po?.qty != null ? qty(line.po.qty) : "—"}
                      received={selected.length ? `${qty(received)}${selected.length > 1 ? ` (${selected.length} receipts)` : ""}` : "Not yet"}
                      billed={qty(line.invoiceQty)}
                      tone={toneOf(checks, [`qty-${line.index}`, `rcpt-${line.index}`])}
                    />
                    <Row
                      label="Rate"
                      order={line.po?.rate != null ? inr(line.po.rate) : "—"}
                      received="—"
                      billed={`${inr(line.invoiceRate)}${rateDelta !== null && Math.abs(rateDelta) > 0.005 ? ` (${rateDelta > 0 ? "+" : "−"}${inr(Math.abs(rateDelta))})` : ""}`}
                      tone={toneOf(checks, [`rate-${line.index}`])}
                    />
                    <Row
                      label="Truck"
                      order="—"
                      received={[...new Set(selected.map((candidate) => candidate.vehicle).filter(Boolean))].join(", ") || "—"}
                      billed={invoice.vehicles.join(", ") || "—"}
                      tone={toneOf(checks, [`anchor-${line.index}`])}
                    />
                  </>
                )}
                <Row
                  label="PO number"
                  order={line.po?.ref ?? "—"}
                  received="—"
                  billed={invoice.poReferences.join(", ") || "—"}
                  tone="ok"
                />
              </tbody>
            </table>

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
              <div>
                <button
                  type="button"
                  className="text-[11px] font-medium text-[#6b4a33] underline"
                  onClick={() => setShowReceipts((current) => !current)}
                >
                  {showReceipts ? "Hide" : "Show"} {service ? "purchase orders" : "receipts"} considered ({line.candidates.length})
                </button>
                {showReceipts ? (
                  <div className="mt-2 overflow-hidden rounded-lg border border-[#e0d8cc]">
                    <ul className="divide-y divide-[#f0ece4]">
                      {line.candidates.map((candidate) => (
                        <CandidateRow
                          key={candidate.key}
                          candidate={candidate}
                          service={service}
                          manual={line.manual}
                          value={valueOf(candidate)}
                          locked={locked}
                          onValue={(next) => {
                            if (service) {
                              onAllocate(line.index, { [candidate.key]: line.invoiceAmount ?? 0 });
                              return;
                            }
                            setEdits((current) => ({ ...current, [candidate.key]: next }));
                          }}
                        />
                      ))}
                    </ul>
                    {!locked && !service ? (
                      <div className="flex flex-wrap items-center gap-2 border-t border-[#f0ece4] bg-[#fcfbf9] px-3 py-2">
                        <Button size="sm" className="h-7 px-2.5 text-[11px]" disabled={busy || !dirty} onClick={apply}>
                          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                          Use my selection
                        </Button>
                        {line.manual || dirty ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 text-[11px]"
                            disabled={busy}
                            onClick={() => {
                              setEdits({});
                              if (line.manual) onResetAllocation(line.index);
                            }}
                          >
                            <RotateCcw className="h-3 w-3" /> Back to automatic
                          </Button>
                        ) : null}
                        <span className="text-[10px] text-[#8a7f72]">
                          Quantities can never exceed what is still open on a receipt.
                        </span>
                      </div>
                    ) : null}
                    {!locked && service && line.manual ? (
                      <div className="border-t border-[#f0ece4] bg-[#fcfbf9] px-3 py-2">
                        <Button size="sm" variant="outline" className="h-7 px-2.5 text-[11px]" disabled={busy} onClick={() => onResetAllocation(line.index)}>
                          <RotateCcw className="h-3 w-3" /> Back to automatic
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
