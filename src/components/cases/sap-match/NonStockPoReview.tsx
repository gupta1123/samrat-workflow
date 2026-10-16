"use client";

import type {
  CandidateView,
  LineResult,
  MatchCheck,
  MatchInvoice,
} from "@/lib/sap-match/types";
import { CheckBlock } from "./CheckBlock";
import { ItemLinker } from "./ItemLinker";
import { ServicePoCandidates } from "./ServicePoCandidates";
import { MatchUpdateNotice } from "./MatchUpdateContext";

/** An unselected, supplier-scoped PO review, not an item mapping or allocation. */
export function NonStockPoReview({
  caseId,
  invoice,
  line,
  cited,
  checks,
  lineCount,
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
  line: LineResult;
  cited: CandidateView[];
  checks: MatchCheck[];
  lineCount: number;
  busy: boolean;
  locked: boolean;
  onChoose: (check: MatchCheck, choice: string, reason: string) => void;
  onUndo: (check: MatchCheck) => void;
  onAllocate: (index: number, allocations: Record<string, number>) => void;
  onResetAllocation: (index: number) => void;
  onLink: (line: LineResult, itemCode: string) => void;
}) {
  const source = invoice.lines.find((entry) => entry.index === line.index);
  const mapCheck = checks.find((check) => check.id === `map-${line.index}`);
  const poNumbers = [...new Set(cited.map((candidate) => candidate.docNum))];
  const items = [
    ...new Map(
      cited.map((candidate) => [candidate.itemCode, candidate]),
    ).values(),
  ];
  return (
    <section
      aria-label={`Non-stock invoice line ${line.index + 1}`}
      className="overflow-hidden rounded-xl border border-[#e0d8cc] bg-white"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[#ece6dc] px-4 py-2.5">
        <h3 className="text-[12px] font-semibold text-[#111827]">
          {source?.description || `Invoice line ${line.index + 1}`}
        </h3>
        <span className="text-[10px] text-[#8a7f72]">
          Line {line.index + 1} of {lineCount}
        </span>
      </header>
      <div className="space-y-3 px-4 py-3 text-[11px]">
        <MatchUpdateNotice lineIndex={line.index} />
        <div>
          <p className="font-medium text-[#8a5207]">
            PO {poNumbers.join(", ")} found · Confirm the invoice line
          </p>
          <p className="mt-1 text-[#6b5d50]">
            SAP confirms these PO items are non-stock. The invoice description
            differs from SAP’s accounting item; confirm the correct PO line.
          </p>
          {items.map((candidate) => (
            <p key={candidate.itemCode} className="mt-1 text-[#3d3530]">
              SAP item: <span className="font-mono">{candidate.itemCode}</span>
              {candidate.itemName ? ` · ${candidate.itemName}` : ""}
            </p>
          ))}
        </div>
        <ServicePoCandidates
          compact
          line={{
            ...line,
            kind: "non-stock",
            candidates: line.nonStockPoCandidates ?? [],
          }}
          invoiceLine={source}
          invoicePoReferences={invoice.poReferences}
          disabled={busy || locked}
          onAllocate={onAllocate}
          onReset={onResetAllocation}
        />
        {checks
          .filter(
            (check) =>
              check.id !== mapCheck?.id && (check.open || check.decision),
          )
          .map((check) => (
            <CheckBlock
              key={check.id}
              check={check}
              busy={busy}
              locked={locked}
              onChoose={(choice, reason) => onChoose(check, choice, reason)}
              onUndo={() => onUndo(check)}
            />
          ))}
        <details className="text-[#6b5d50]">
          <summary className="cursor-pointer font-medium text-[#6b4a33]">
            This PO does not describe the purchase?
          </summary>
          <p className="my-2">
            Review another supplier PO above, or link a SAP item below. No item
            or PO line has been selected automatically.
          </p>
          {mapCheck ? (
            <ItemLinker
              caseId={caseId}
              check={mapCheck}
              canLink
              busy={busy || locked}
              onLink={(itemCode) => onLink(line, itemCode)}
            />
          ) : null}
        </details>
        {source?.source?.fileName || invoice.source?.fileName ? (
          <p className="text-[10px] text-[#8a7f72]">
            Invoice source:{" "}
            {source?.source?.fileName || invoice.source?.fileName} ·{" "}
            {source?.source?.pageLabel || invoice.source?.pageLabel || "PDF"}
          </p>
        ) : null}
      </div>
    </section>
  );
}
