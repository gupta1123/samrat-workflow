"use client";
import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
  CandidateView,
  LineResult,
  MatchInvoiceLine,
} from "@/lib/sap-match/types";
import { formatDate, inr, qty } from "./format";
import { useMatchUpdate } from "./MatchUpdateContext";
import { nonStockPoReferenceMatches } from "@/lib/sap-match/non-stock-po-review";

const EPSILON = 0.005;

function refKey(value: string | number | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

/** Tone of one number cell: only a real difference gets colour. */
const TONE = {
  bad: "font-semibold text-[#b3261e]",
  warn: "font-semibold text-[#9a5a0a]",
  ok: "text-[#111827]",
} as const;
const CHIP = {
  bad: "bg-[#fbe7e5] text-[#b3261e]",
  warn: "bg-[#fdf1dc] text-[#8a5207]",
  ok: "bg-[#eef3ee] text-[#3d5a47]",
} as const;

type Fact = { tone: keyof typeof CHIP; text: string };

/** Plain differences between the invoice line and one SAP PO line. Facts only: no score, no ranking. */
function factsFor(
  candidate: CandidateView,
  invoiceLine: MatchInvoiceLine | undefined,
  invoiceAmount: number | null,
) {
  const facts: Fact[] = [];
  const cells: {
    quantity: keyof typeof TONE;
    price: keyof typeof TONE;
    amount: keyof typeof TONE;
  } = { quantity: "ok", price: "ok", amount: "ok" };
  if (candidate.rejected) return { facts, cells };

  if (invoiceAmount != null && invoiceAmount > candidate.open + EPSILON) {
    cells.amount = "bad";
    facts.push({
      tone: "bad",
      text: `Invoice is ${inr(invoiceAmount - candidate.open)} more than is left`,
    });
  }
  const items = candidate.documentType === "dDocument_Items";
  const openQuantity = candidate.poEvidence?.openQuantity;
  if (
    items &&
    invoiceLine?.quantity != null &&
    openQuantity != null &&
    invoiceLine.quantity > openQuantity + EPSILON
  ) {
    cells.quantity = "bad";
    facts.push({
      tone: "bad",
      text: `Invoice quantity ${qty(invoiceLine.quantity)} · only ${qty(openQuantity)} open`,
    });
  }
  if (
    items &&
    invoiceLine?.rate != null &&
    candidate.price != null &&
    Math.abs(invoiceLine.rate - candidate.price) > EPSILON
  ) {
    cells.price = "warn";
    facts.push({
      tone: "warn",
      text: `Unit price ${inr(invoiceLine.rate)} on invoice · ${inr(candidate.price)} in SAP`,
    });
  }
  if (invoiceLine?.vendorItemCode && candidate.itemCode) {
    facts.push(
      refKey(invoiceLine.vendorItemCode) === refKey(candidate.itemCode)
        ? { tone: "ok", text: "Item code is the same" }
        : { tone: "warn", text: "Item code differs" },
    );
  }
  // A row already wrong on amount or quantity does not also need a price warning.
  if (cells.amount === "bad" || cells.quantity === "bad") cells.price = "ok";
  return { facts, cells };
}

function citedPos(
  invoicePoReferences: string[],
  candidates: CandidateView[],
  nonStock: boolean,
) {
  const printed = new Set(invoicePoReferences.filter(Boolean).map(refKey));
  if (!printed.size) return [];
  return [
    ...new Set(
      candidates
        .filter(
          (candidate) =>
            (nonStock &&
              nonStockPoReferenceMatches(invoicePoReferences, [
                candidate.docNum,
                ...(candidate.references?.po ?? []),
              ])) ||
            printed.has(refKey(candidate.docNum)) ||
            (candidate.references?.po ?? []).some((ref) =>
              printed.has(refKey(ref)),
            ),
        )
        .map((candidate) => candidate.docEntry),
    ),
  ];
}

function whyChoosing(
  invoicePoReferences: string[],
  candidates: CandidateView[],
  poCount: number,
  cited: number[],
) {
  const printed = invoicePoReferences.filter(Boolean);
  if (!printed.length)
    return "The invoice does not print a PO number. Choose the SAP line it belongs to.";
  if (cited.length) {
    const numbers = [
      ...new Set(
        candidates
          .filter((candidate) => cited.includes(candidate.docEntry))
          .map((candidate) => candidate.docNum),
      ),
    ];
    return `The invoice cites PO ${printed.join(", ")}, which is in SAP (PO ${numbers.join(", ")}). Confirm the correct line before continuing.`;
  }
  return `The invoice cites PO ${printed.join(", ")}. None of the available PO candidates has that reference, so ${
    poCount === 1
      ? "this supplier's open PO is"
      : "this supplier's open POs are"
  } shown for you to choose from.`;
}

export function ServicePoCandidates({
  line,
  invoiceLine,
  invoicePoReferences = [],
  disabled,
  onAllocate,
  onReset,
  compact = false,
}: {
  line: LineResult;
  invoiceLine: MatchInvoiceLine | undefined;
  invoicePoReferences?: string[];
  disabled: boolean;
  onAllocate: (index: number, allocations: Record<string, number>) => void;
  onReset: (index: number) => void;
  compact?: boolean;
}) {
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const update = useMatchUpdate(line.index);
  const pendingAllocations =
    update?.phase !== "failed" && update?.action?.action === "allocate"
      ? update.action.allocations
      : null;
  const nonStock = line.kind === "non-stock";
  const selectedCandidate = line.candidates.find(
    (candidate) => candidate.allocated > 0,
  );
  const selectedKey = pendingAllocations
    ? (Object.entries(pendingAllocations).find(
        ([, amount]) => amount > 0,
      )?.[0] ?? null)
    : (selectedCandidate?.key ?? null);
  const checkedKey = picked ?? selectedKey;
  const cited = citedPos(invoicePoReferences, line.candidates, nonStock);
  const [poFilter, setPoFilter] = useState(
    selectedCandidate != null
      ? String(selectedCandidate.docEntry)
      : cited.length === 1
        ? String(cited[0])
        : "",
  );
  const pos = [
    ...new Map(
      line.candidates.map((candidate) => [candidate.docEntry, candidate]),
    ).values(),
  ];
  const leftOnPo = (docEntry: number) =>
    line.candidates
      .filter((candidate) => candidate.docEntry === docEntry)
      .reduce((sum, candidate) => sum + (candidate.open ?? 0), 0);
  const poLabel = (po: CandidateView) =>
    `PO ${po.docNum} · ${formatDate(po.date)} · ${inr(leftOnPo(po.docEntry))} left`;
  const needsPoChoice = nonStock && pos.length > 1 && !poFilter;
  const inPo = poFilter
    ? line.candidates.filter(
        (candidate) => String(candidate.docEntry) === poFilter,
      )
    : needsPoChoice
      ? []
      : line.candidates;
  const unavailable = inPo.filter((candidate) => candidate.rejected);
  const visible = inPo.filter(
    (candidate) =>
      !compact ||
      showUnavailable ||
      !candidate.rejected ||
      candidate.allocated > 0,
  );
  const groups = [
    ...visible
      .reduce((map, candidate) => {
        map.set(candidate.docEntry, [
          ...(map.get(candidate.docEntry) ?? []),
          candidate,
        ]);
        return map;
      }, new Map<number, CandidateView[]>())
      .values(),
  ];
  const invoiceAmount = line.invoiceAmount;
  const factsByKey = new Map(
    visible.map((candidate) => [
      candidate.key,
      factsFor(candidate, invoiceLine, invoiceAmount),
    ]),
  );

  // One shared note instead of the same sentence under every candidate.
  const notes = visible.map((candidate) =>
    candidate.rejected === "Fully billed already"
      ? "No remaining value for this selection"
      : candidate.rejected || [...candidate.good, ...candidate.bad].join(" · "),
  );
  const sharedNote =
    notes.length > 0 && notes.every((note) => note === notes[0])
      ? notes[0]
      : null;
  const showQuantity = visible.some(
    (candidate) => candidate.documentType === "dDocument_Items",
  );
  const columns = showQuantity ? 5 : 3;
  const canConfirm =
    Boolean(picked) && picked !== selectedKey && !disabled && !!invoiceAmount;

  return (
    <div className="space-y-3 text-[11px]">
      <div>
        <h4 className="text-[12px] font-semibold text-[#111827]">
          Choose the PO line for this invoice line
        </h4>
        <p className="mt-0.5 text-[#6b5d50]">
          {whyChoosing(invoicePoReferences, line.candidates, pos.length, cited)}
        </p>
      </div>

      <p className="rounded-lg border border-[#e0d8cc] bg-[#faf8f4] px-3 py-2 text-[#6b5d50]">
        <span className="text-[10px] font-medium uppercase tracking-wider text-[#8a7f72]">
          Invoice line{" "}
        </span>
        {[
          invoiceLine?.vendorItemCode
            ? `Code ${invoiceLine.vendorItemCode}`
            : null,
          invoiceLine?.quantity != null
            ? `${qty(invoiceLine.quantity)} ${invoiceLine.unit ?? ""}`.trim()
            : null,
          invoiceLine?.rate != null
            ? `Unit price ${inr(invoiceLine.rate)}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        {" · "}
        <strong className="tabular-nums text-[#111827]">
          {inr(invoiceAmount)}
        </strong>
        {" · PO reference "}
        {invoicePoReferences.join(", ") || "not printed"}
      </p>

      {pos.length > 1 ? (
        <label className="flex flex-wrap items-center gap-2 font-medium text-[#3d3530]">
          Filter by SAP PO
          <select
            className="min-w-[18rem] max-w-full rounded-md border border-[#e0d8cc] bg-white p-2 font-normal"
            value={poFilter}
            onChange={(event) => {
              setPoFilter(event.target.value);
              setPicked(null);
            }}
          >
            <option value="">
              {nonStock
                ? `Choose a PO (${pos.length} supplier POs)`
                : `All ${pos.length} supplier POs`}
            </option>
            {cited.length ? (
              <optgroup label="Cited on the invoice">
                {pos
                  .filter((po) => cited.includes(po.docEntry))
                  .map((po) => (
                    <option key={po.docEntry} value={String(po.docEntry)}>
                      {poLabel(po)}
                    </option>
                  ))}
              </optgroup>
            ) : null}
            <optgroup label={cited.length ? "Other open POs" : "Open POs"}>
              {pos
                .filter((po) => !cited.includes(po.docEntry))
                .map((po) => (
                  <option key={po.docEntry} value={String(po.docEntry)}>
                    {poLabel(po)}
                  </option>
                ))}
            </optgroup>
          </select>
        </label>
      ) : null}

      {needsPoChoice ? (
        <p className="text-[#6b5d50]">
          Choose the SAP PO to compare its lines. No PO has been selected or
          ranked automatically.
        </p>
      ) : null}

      {groups.length ? (
        <div className="overflow-x-auto rounded-lg border border-[#e0d8cc] bg-white">
          <table className="w-full min-w-[560px] table-fixed text-[11px]">
            <thead>
              <tr className="border-b border-[#ece6dc] text-left text-[10px] font-medium uppercase tracking-wider text-[#8a7f72]">
                <th scope="col" className="w-8 px-3 py-1.5">
                  <span className="sr-only">Select</span>
                </th>
                <th scope="col" className="px-3 py-1.5">
                  SAP PO line{showQuantity ? " · Non-stock items" : ""}
                </th>
                {showQuantity ? (
                  <>
                    <th
                      scope="col"
                      className="w-32 whitespace-nowrap px-3 py-1.5 text-right"
                    >
                      Open quantity
                    </th>
                    <th
                      scope="col"
                      className="w-24 whitespace-nowrap px-3 py-1.5 text-right"
                    >
                      Unit price
                    </th>
                  </>
                ) : null}
                <th
                  scope="col"
                  className="w-28 whitespace-nowrap px-3 py-1.5 text-right"
                >
                  Open value
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const head = group[0];
                return (
                  <Fragment key={head.docEntry}>
                    <tr className="border-b border-[#ece6dc] bg-[#faf8f4]">
                      <th
                        scope="colgroup"
                        colSpan={columns}
                        className="px-3 py-1.5 text-left font-normal text-[#6b5d50]"
                      >
                        <strong className="font-semibold text-[#111827]">
                          PO {head.docNum}
                        </strong>
                        {` · ${formatDate(head.date)}`}
                        {head.poEvidence?.headerRemarks ? (
                          <span
                            className="block break-words"
                            title={head.poEvidence.headerRemarks}
                          >
                            PO remarks: {head.poEvidence.headerRemarks}
                          </span>
                        ) : null}
                      </th>
                    </tr>
                    {group.map((candidate) => {
                      const { facts, cells } = factsByKey.get(candidate.key)!;
                      const checked = checkedKey === candidate.key;
                      const blocked =
                        disabled ||
                        Boolean(candidate.rejected) ||
                        !invoiceAmount;
                      const items =
                        candidate.documentType === "dDocument_Items";
                      const description =
                        candidate.poEvidence?.description ||
                        candidate.itemName ||
                        candidate.note ||
                        (items ? null : "Service PO");
                      return (
                        <tr
                          key={candidate.key}
                          className={`border-b border-[#f0ece4] align-top last:border-b-0 ${checked ? "bg-[#f1f8f4]" : candidate.rejected ? "opacity-60" : blocked ? "" : "cursor-pointer hover:bg-[#faf8f4]"}`}
                          onClick={() => {
                            if (!blocked) setPicked(candidate.key);
                          }}
                        >
                          <td className="px-3 py-2">
                            <input
                              type="radio"
                              name={`service-po-${line.index}`}
                              aria-label={`PO ${candidate.docNum}, line ${candidate.lineNum + 1}`}
                              checked={checked}
                              disabled={blocked}
                              onChange={() => setPicked(candidate.key)}
                            />
                          </td>
                          <td className="min-w-0 break-words px-3 py-2">
                            <span className="block font-semibold text-[#111827]">
                              {compact
                                ? `Line ${candidate.lineNum + 1}`
                                : `SAP line ${candidate.lineNum}`}
                              {candidate.poEvidence?.lineRemarks
                                ? ` · ${candidate.poEvidence.lineRemarks}`
                                : ""}
                            </span>
                            <span className="block text-[#6b5d50]">
                              {[
                                items && candidate.itemCode
                                  ? `${candidate.itemCode}${candidate.itemName ? ` · ${candidate.itemName}` : ""}`
                                  : null,
                                !items
                                  ? `Service account ${candidate.accountCode || "not recorded"}`
                                  : null,
                                description &&
                                refKey(description) !==
                                  refKey(candidate.itemName)
                                  ? description
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" · ") || "Description not recorded"}
                            </span>
                            {(checked || visible.length <= 4) &&
                            facts.length ? (
                              <span className="mt-1 flex flex-wrap gap-1">
                                {facts.map((fact) => (
                                  <span
                                    key={fact.text}
                                    className={`rounded-full px-2 py-0.5 text-[10px] ${CHIP[fact.tone]}`}
                                  >
                                    {fact.text}
                                  </span>
                                ))}
                              </span>
                            ) : null}
                            {candidate.rejected ? (
                              <span className="mt-1 block text-[#6b5d50]">
                                {candidate.rejected === "Fully billed already"
                                  ? "No remaining value for this selection"
                                  : candidate.rejected}
                              </span>
                            ) : sharedNote === null ? (
                              <span className="mt-1 block text-[#8a7f72]">
                                {[...candidate.good, ...candidate.bad].join(
                                  " · ",
                                )}
                              </span>
                            ) : null}
                          </td>
                          {showQuantity ? (
                            <>
                              <td
                                className={`px-3 py-2 text-right tabular-nums ${TONE[cells.quantity]}`}
                              >
                                {items
                                  ? qty(candidate.poEvidence?.openQuantity)
                                  : "—"}
                              </td>
                              <td
                                className={`px-3 py-2 text-right tabular-nums ${TONE[cells.price]}`}
                              >
                                {items ? inr(candidate.price) : "—"}
                              </td>
                            </>
                          ) : null}
                          <td
                            className={`px-3 py-2 text-right tabular-nums ${TONE[cells.amount]}`}
                          >
                            {inr(candidate.open)}
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {sharedNote ? <p className="text-[#8a7f72]">{sharedNote}</p> : null}

      {compact && unavailable.length ? (
        <button
          type="button"
          className="underline"
          onClick={() => setShowUnavailable(!showUnavailable)}
        >
          {showUnavailable
            ? "Hide unavailable lines"
            : `Show unavailable lines (${unavailable.length})`}
        </button>
      ) : null}

      {canConfirm ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#c4dfcf] bg-[#f1f8f4] px-3 py-2">
          <span className="font-medium text-[#24583e]">
            {(() => {
              const chosen = line.candidates.find(
                (candidate) => candidate.key === picked,
              );
              return chosen
                ? `PO ${chosen.docNum} · line ${chosen.lineNum + 1} selected`
                : "PO line selected";
            })()}
          </span>
          <Button
            type="button"
            size="sm"
            className="h-7 px-2.5 text-[11px]"
            onClick={() => {
              onAllocate(line.index, { [picked!]: invoiceAmount! });
              setPicked(null);
            }}
          >
            Confirm PO line
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[11px]"
            onClick={() => setPicked(null)}
          >
            Cancel
          </Button>
        </div>
      ) : null}

      {groups.length ? (
        <p className="text-[#6b5d50]">
          None of these fit? Use “Mark for supplier correction” above. Choosing
          a line confirms the PO and accounting item for this invoice only; no
          reusable product mapping is saved.
        </p>
      ) : null}

      {line.manual ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onReset(line.index)}
          className="underline"
        >
          Reset PO selection
        </button>
      ) : null}
    </div>
  );
}
