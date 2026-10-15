"use client";
import { useState } from "react";
import type { LineResult, MatchInvoiceLine } from "@/lib/sap-match/types";
import { inr, qty } from "./format";

export function ServicePoCandidates({
  line,
  invoiceLine,
  invoicePoReferences = [],
  disabled,
  onAllocate,
  onReset,
}: {
  line: LineResult;
  invoiceLine: MatchInvoiceLine | undefined;
  invoicePoReferences?: string[];
  disabled: boolean;
  onAllocate: (index: number, allocations: Record<string, number>) => void;
  onReset: (index: number) => void;
}) {
  const nonStock = line.kind === "non-stock";
  const selectedPo = line.candidates.find(
    (candidate) => candidate.allocated > 0,
  )?.docEntry;
  const [poFilter, setPoFilter] = useState(
    selectedPo == null ? "" : String(selectedPo),
  );
  const pos = [
    ...new Map(
      line.candidates.map((candidate) => [candidate.docEntry, candidate]),
    ).values(),
  ];
  const candidates = poFilter
    ? line.candidates.filter(
        (candidate) => String(candidate.docEntry) === poFilter,
      )
    : nonStock && pos.length > 1
      ? []
      : line.candidates;
  return (
    <div className="space-y-2 text-[11px]">
      <h4 className="font-semibold">
        {nonStock ? "Non-stock PO lines — confirm one" : "Service PO lines"}
      </h4>
      <p className="text-[#6b5d50]">
        {nonStock
          ? "Compare the invoice with the complete SAP PO line, including its remarks. Selecting a line confirms the PO and accounting item for this invoice only; it does not save a reusable product mapping."
          : "Compare the invoice service with the SAP item or account, then select the correct PO line. No GRPO, vehicle or weight is required."}
      </p>
      <label className="block font-medium">
        Filter by SAP PO
        <select
          className="ml-2 rounded-md border border-[#e0d8cc] bg-white p-2"
          value={poFilter}
          onChange={(event) => setPoFilter(event.target.value)}
        >
          <option value="">
            {nonStock && pos.length > 1
              ? `Choose a PO (${pos.length} supplier POs)`
              : `All ${pos.length} supplier POs`}
          </option>
          {pos.map((po) => (
            <option key={po.docEntry} value={String(po.docEntry)}>
              PO {po.docNum} · {po.date ?? "Date not recorded"}
            </option>
          ))}
        </select>
      </label>
      {nonStock && pos.length > 1 && !poFilter ? (
        <p className="text-[#6b5d50]">
          Choose the SAP PO to compare its lines. No PO has been selected or
          ranked automatically.
        </p>
      ) : null}
      {candidates.map((candidate) => (
        <label
          key={candidate.key}
          className="flex items-start gap-2 rounded-lg border border-[#e0d8cc] p-2"
        >
          <input
            type="radio"
            name={`service-po-${line.index}`}
            checked={candidate.allocated > 0}
            disabled={
              disabled || Boolean(candidate.rejected) || !line.invoiceAmount
            }
            onChange={() =>
              onAllocate(line.index, { [candidate.key]: line.invoiceAmount! })
            }
          />
          <span className="min-w-0 flex-1">
            <strong>
              PO {candidate.docNum} · SAP line {candidate.lineNum}
            </strong>
            <span className="block">{candidate.note || "Service PO"}</span>
            <span className="my-2 grid gap-3 rounded-md bg-[#faf8f4] p-2 sm:grid-cols-2">
              <span className="min-w-0 break-words">
                <strong className="block">From the invoice</strong>
                <span className="block">
                  Code:{" "}
                  {invoiceLine?.vendorItemCode || "Not printed / extracted"}
                </span>
                <span className="block">
                  Name: {invoiceLine?.description || "Not recorded"}
                </span>
                <span className="block">Amount: {inr(line.invoiceAmount)}</span>
                <span className="block">
                  Quantity: {qty(invoiceLine?.quantity)}{" "}
                  {invoiceLine?.unit ?? ""}
                </span>
                <span className="block">
                  Unit price: {inr(invoiceLine?.rate)}
                </span>
                <span className="block">
                  PO reference:{" "}
                  {invoicePoReferences.join(", ") || "Not recorded"}
                </span>
              </span>
              <span className="min-w-0 break-words">
                <strong className="block">From SAP</strong>
                {candidate.documentType === "dDocument_Items" ? (
                  <>
                    <span className="block">Code: {candidate.itemCode}</span>
                    <span className="block">
                      Name: {candidate.itemName || "Not recorded"}
                    </span>
                    <span className="block">Non-stock item</span>
                  </>
                ) : (
                  <span className="block">
                    Service account: {candidate.accountCode || "Not recorded"}
                  </span>
                )}
                <span className="block">Open value: {inr(candidate.open)}</span>
                <span className="block">
                  PO reference:{" "}
                  {candidate.references?.po.join(", ") ||
                    String(candidate.docNum)}
                </span>
                {candidate.poEvidence ? (
                  <>
                    <span className="block">
                      PO line description:{" "}
                      {candidate.poEvidence.description ?? "Not recorded"}
                    </span>
                    <span className="block font-medium">
                      Line remarks:{" "}
                      {candidate.poEvidence.lineRemarks ?? "Not recorded"}
                    </span>
                    <span className="block">
                      PO remarks:{" "}
                      {candidate.poEvidence.headerRemarks ?? "Not recorded"}
                    </span>
                    <span className="block">
                      Open quantity: {qty(candidate.poEvidence.openQuantity)}
                    </span>
                    <span className="block">
                      Unit price: {inr(candidate.price)}
                    </span>
                  </>
                ) : null}
              </span>
            </span>
            <span className="block text-[#6b5d50]">
              {candidate.rejected ||
                [...candidate.good, ...candidate.bad].join(" · ")}
            </span>
          </span>
        </label>
      ))}
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
