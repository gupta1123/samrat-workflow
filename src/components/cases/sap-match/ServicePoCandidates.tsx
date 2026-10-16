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
  return { facts, cells };
}

function whyChoosing(
  invoicePoReferences: string[],
  candidates: CandidateView[],
  poCount: number,
) {
  const printed = invoicePoReferences.filter(Boolean);
  if (!printed.length)
    return "The invoice does not print a PO number. Choose the SAP line it belongs to.";
  const known = new Set(
    candidates.flatMap((candidate) => [
      refKey(candidate.docNum),
      ...(candidate.references?.po ?? []).map(refKey),
    ]),
  );
  if (printed.some((reference) => known.has(refKey(reference))))
    return "The invoice cites one of the available SAP POs. Confirm the correct line before continuing.";
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
  const [poFilter, setPoFilter] = useState(
    selectedCandidate == null ? "" : String(selectedCandidate.docEntry),
  );
  const pos = [
    ...new Map(
      line.candidates.map((candidate) => [candidate.docEntry, candidate]),
    ).values(),
  ];
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
          {whyChoosing(invoicePoReferences, line.candidates, pos.length)}
        </p>
      </div>

      <dl className="grid gap-x-6 gap-y-1 rounded-lg border border-[#e0d8cc] bg-[#faf8f4] px-3 py-2 sm:grid-cols-[auto_1fr]">
        <dt className="text-[10px] font-medium uppercase tracking-wider text-[#8a7f72]">
          This invoice line
        </dt>
        <dd className="min-w-0 break-words font-medium text-[#111827]">
          {invoiceLine?.description || "Description not recorded"}
        </dd>
        <dt className="sr-only">Details</dt>
        <dd className="text-[#6b5d50] sm:col-start-2">
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
        </dd>
      </dl>

      {pos.length > 1 ? (
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Filter by SAP PO"
        >
          <span className="font-medium text-[#3d3530]">Filter by SAP PO</span>
          {!nonStock ? (
            <button
              type="button"
              aria-pressed={!poFilter}
              className={`rounded-full border px-2.5 py-1 ${!poFilter ? "border-[#6b4a33] bg-[#f4ece2] font-semibold" : "border-[#e0d8cc] bg-white"}`}
              onClick={() => {
                setPoFilter("");
                setPicked(null);
              }}
            >
              All {pos.length} POs
            </button>
          ) : null}
          {pos.map((po) => {
            const active = poFilter === String(po.docEntry);
            const left = line.candidates
              .filter((candidate) => candidate.docEntry === po.docEntry)
              .reduce((sum, candidate) => sum + (candidate.open ?? 0), 0);
            return (
              <button
                key={po.docEntry}
                type="button"
                aria-pressed={active}
                className={`rounded-full border px-2.5 py-1 ${active ? "border-[#6b4a33] bg-[#f4ece2] font-semibold" : "border-[#e0d8cc] bg-white"}`}
                onClick={() => {
                  setPoFilter(String(po.docEntry));
                  setPicked(null);
                }}
              >
                PO {po.docNum} · {formatDate(po.date)} · {inr(left)} left
              </button>
            );
          })}
        </div>
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
                  SAP PO line
                </th>
                {showQuantity ? (
                  <>
                    <th scope="col" className="w-24 px-3 py-1.5 text-right">
                      Open quantity
                    </th>
                    <th scope="col" className="w-24 px-3 py-1.5 text-right">
                      Unit price
                    </th>
                  </>
                ) : null}
                <th scope="col" className="w-28 px-3 py-1.5 text-right">
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
                              {description ?? "Description not recorded"}
                              {items && candidate.itemCode
                                ? ` · ${candidate.itemCode}${candidate.itemName ? ` ${candidate.itemName}` : ""} · Non-stock item`
                                : null}
                              {!items
                                ? ` · Service account ${candidate.accountCode || "not recorded"}`
                                : null}
                            </span>
                            {facts.length ? (
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
