import type {
  CandidateView,
  LineResult,
  MatchInvoice,
  MatchResult,
} from "@/lib/sap-match/types";
import { Fragment } from "react";
import {
  candidateEvidence,
  itemIdentificationLabel,
  type EvidenceRow,
} from "@/lib/sap-match/evidence";

const color = {
  Matched: "text-[#24583e]",
  Different: "text-[#9a5a0a]",
  "Partly matched": "text-[#9a5a0a]",
  "Not checked": "text-[#6b5d50]",
};

function EvidenceTable({
  rows,
  sapLabel,
  compact = false,
}: {
  rows: EvidenceRow[];
  sapLabel: string;
  compact?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table
        className={`w-full ${compact ? "min-w-[320px]" : "min-w-[420px]"} text-left text-[11px] leading-4`}
      >
        <thead className="text-[10px] text-[#6b5d50]">
          <tr>
            <th scope="col" className="w-[22%] pb-1 font-medium">
              Field
            </th>
            <th scope="col" className="w-[31%] pb-1 pr-3 font-medium">
              Scanned packet
            </th>
            <th scope="col" className="w-[31%] pb-1 pr-3 font-medium">
              {sapLabel}
            </th>
            <th scope="col" className="pb-1 font-medium">
              Result
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Fragment key={row.label}>
              <tr className="border-t border-[#f0ece4] align-top">
                <th
                  scope="row"
                  className="py-1.5 pr-3 font-normal text-[#6b5d50]"
                >
                  {row.label}
                </th>
                <td className="break-words py-1.5 pr-3 text-[#111827]">
                  <span title={row.source}>{row.scanned}</span>
                </td>
                <td className="break-words py-1.5 pr-3 text-[#111827]">
                  {row.sap}
                </td>
                <td className={`py-1.5 font-medium ${color[row.status]}`}>
                  {row.status}
                </td>
              </tr>
              {row.note ? (
                <tr>
                  <td
                    colSpan={4}
                    className="pb-1.5 text-[10px] leading-4 text-[#6b5d50]"
                  >
                    {row.note}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
      {rows.some((row) => row.source) ? (
        <details className="mt-1 text-[10px] leading-4 text-[#6b5d50]">
          <summary className="cursor-pointer">
            Scanned reference sources
          </summary>
          <ul className="mt-1 space-y-0.5">
            {rows
              .filter((row) => row.source)
              .map((row) => (
                <li key={row.label}>
                  {row.label}: {row.source}
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function SupplierEvidence({
  invoice,
  vendor,
  result,
}: {
  invoice: MatchInvoice;
  vendor: { cardCode: string; cardName: string } | null;
  result: MatchResult;
}) {
  const identification = result.supplierIdentification;
  const label = !identification
    ? "Identification method not recorded"
    : {
        gstin: "Identified by exact GSTIN",
        name: "Identified by exact supplier name",
        "saved-mapping": "Reused a saved supplier mapping",
        reviewer: "Supplier selected by reviewer for this packet",
      }[identification.method];
  const gstins = identification?.sapGstins ?? [];
  const sameGstin = Boolean(
    invoice.vendorGstin &&
    gstins.some(
      (gstin) =>
        gstin.toUpperCase() === invoice.vendorGstin?.trim().toUpperCase(),
    ),
  );
  return (
    <section className="border-b border-[#e0d8cc] pb-2">
      <div className="mb-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
        <h3 className="font-semibold text-[#111827]">
          Supplier identification
        </h3>
        <span className="text-[#6b5d50]">{label}</span>
      </div>
      <div className="grid gap-1 text-[11px] sm:grid-cols-2">
        <p className="text-[#6b5d50]">
          Scanned invoice:{" "}
          <span className="text-[#111827]">
            {invoice.vendorName ?? "Name not recorded"}
          </span>
        </p>
        <p className="text-[#6b5d50]">
          SAP Business Partner:{" "}
          <span className="text-[#111827]">
            {vendor
              ? `${vendor.cardName} (${vendor.cardCode})`
              : "Not identified"}
          </span>
        </p>
      </div>
      <p className="mt-1 text-[10px] leading-4 text-[#6b5d50]">
        GSTIN:{" "}
        <span className="font-mono">
          {invoice.vendorGstin ?? "Not recorded on invoice"}
        </span>{" "}
        → SAP:{" "}
        <span className="font-mono">
          {gstins.join(", ") || "Not recorded in check"}
        </span>{" "}
        ·{" "}
        <span className={sameGstin ? color.Matched : color["Not checked"]}>
          {sameGstin
            ? "Matched"
            : invoice.vendorGstin && gstins.length
              ? "Different; supplier linked by another method"
              : "Not checked"}
        </span>
      </p>
    </section>
  );
}

export function CandidateEvidence({
  invoice,
  candidate,
  compact,
}: {
  invoice: MatchInvoice;
  candidate: CandidateView;
  compact?: boolean;
}) {
  return (
    <EvidenceTable
      rows={candidateEvidence(invoice, candidate)}
      sapLabel={`SAP ${candidate.kind} ${candidate.docNum}`}
      compact={compact}
    />
  );
}

export function MatchingEvidence({
  invoice,
  line,
  locked,
}: {
  invoice: MatchInvoice;
  line: LineResult;
  locked: boolean;
}) {
  const selected = line.candidates.filter(
    (candidate) => candidate.allocated > 0,
  );
  return (
    <section className="border-t border-[#ece6dc] pt-2">
      <div className="mb-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
        <h3 className="font-semibold text-[#111827]">How this matched</h3>
        <span className="text-[#6b5d50]">{itemIdentificationLabel(line)}</span>
      </div>
      <p className="mb-1 text-[10px] leading-4 text-[#6b5d50]">
        {selected.length
          ? `${locked ? "Saved selection" : line.manual ? "Reviewer selection" : "Automatic selection"} · ${line.kind === "service" ? "Supplier, item and PO reference checked; GRPO not required for services." : "Supplier and SAP item restrict the candidates; references and open quantity rank the GRPOs."}`
          : "No base document selected. The candidate list below explains what was found or excluded."}
      </p>
      {!selected.length ? (
        <p className="text-[11px] leading-4 text-[#6b5d50]">
          Scanned packet PO references:{" "}
          {invoice.poReferences.join(", ") || "Not recorded"}
          {line.po?.docNum != null
            ? ` · SAP PO ${line.po.docNum} found; no GRPO selected.`
            : ""}
        </p>
      ) : null}
      {selected.map((candidate) => (
        <div key={candidate.key} className="mt-2">
          <p className="mb-1 text-[11px] font-medium text-[#3d3530]">
            {candidate.kind} {candidate.docNum}, line {candidate.lineNum + 1}
            {candidate.kind === "GRPO"
              ? candidate.purchaseOrder
                ? ` → PO ${candidate.purchaseOrder.docNum ?? `Entry ${candidate.purchaseOrder.docEntry}`}${candidate.purchaseOrder.lineNum != null ? `, line ${candidate.purchaseOrder.lineNum + 1}` : " (line not recorded)"}`
                : " → PO link not recorded in check"
              : ""}
          </p>
          <CandidateEvidence invoice={invoice} candidate={candidate} />
        </div>
      ))}
    </section>
  );
}
