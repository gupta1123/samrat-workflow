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
  quantityBalances,
  type EvidenceRow,
} from "@/lib/sap-match/evidence";
import { inr, qty } from "./format";

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
                  {row.status === "Not checked" ? "Unverified" : row.status}
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
      {!compact && rows.some((row) => row.source) ? (
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
  const invoiceGstin = invoice.vendorGstin?.trim().toUpperCase() ?? "";
  const gstins = [
    ...new Set(
      (identification?.sapGstins ?? [])
        .map((gstin) => gstin.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  const sameGstin = Boolean(invoiceGstin && gstins.includes(invoiceGstin));
  const otherGstins = gstins.filter((gstin) => gstin !== invoiceGstin);
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
      <p
        className={`mt-1 text-[10px] leading-4 ${sameGstin ? color.Matched : color["Not checked"]}`}
      >
        {!invoiceGstin ? (
          "Supplier GSTIN was not extracted from the scanned invoice."
        ) : (
          <>
            Invoice GSTIN <span className="font-mono">{invoiceGstin}</span>{" "}
            {sameGstin ? (
              <>
                matches{" "}
                {vendor ? (
                  <>
                    SAP supplier{" "}
                    <span className="font-mono">{vendor.cardCode}</span>
                  </>
                ) : (
                  "the SAP Business Partner's address records"
                )}
                .
              </>
            ) : gstins.length ? (
              "was not found in this SAP supplier's address records. Supplier linked by another method."
            ) : (
              "— SAP GSTINs were not recorded in this check."
            )}
          </>
        )}
      </p>
      {otherGstins.length ? (
        <details className="mt-1 text-[10px] leading-4 text-[#6b5d50]">
          <summary className="cursor-pointer">
            {sameGstin ? "Other SAP GSTINs" : "SAP GSTINs"} (
            {otherGstins.length})
          </summary>
          <p className="mt-1">
            Unique GSTINs from this Business Partner&apos;s SAP address records.
          </p>
          <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono">
            {otherGstins.map((gstin) => (
              <li key={gstin}>{gstin}</li>
            ))}
          </ul>
        </details>
      ) : null}
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

export function ItemMatchingEvidence({
  invoice,
  line,
}: {
  invoice: MatchInvoice;
  line: LineResult;
}) {
  const source = invoice.lines.find((entry) => entry.index === line.index);
  const identification = line.itemIdentification;
  const explanation = !line.itemCode
    ? "No SAP item has been linked yet. Any suggested item needs your confirmation before it can be used."
    : identification?.method === "exact-code"
      ? null
      : identification?.method === "saved-mapping"
        ? identification.scope === "supplier"
          ? "A saved link for this supplier connects the invoice item to this SAP item. The SAP name comes from Item Master."
          : identification.scope === "shared"
            ? "A saved shared item link connects the invoice item to this SAP item. The SAP name comes from Item Master."
            : "A saved item link connects the invoice item to this SAP item. Its scope was not recorded in this check. The SAP name comes from Item Master."
        : "This saved check contains the SAP item, but does not record how it was identified. Re-check to record the matching method.";

  return (
    <section
      aria-label="Item matching"
      className="rounded-lg border border-[#e0d8cc] bg-[#faf8f4] p-3 text-[11px] leading-4"
    >
      <h3 className="font-semibold text-[#111827]">How the item matched</h3>
      <p className="mt-1 font-medium text-[#6b4a33]">
        {line.itemCode ? itemIdentificationLabel(line) : "Item not linked"}
      </p>
      <table
        className="mt-2 w-full table-fixed text-left"
        aria-label="Invoice and SAP item comparison"
      >
        <thead>
          <tr className="border-b border-[#e0d8cc] text-[#6b5d50]">
            <th scope="col" className="py-2 pr-3 font-medium">
              From the invoice
            </th>
            <th scope="col" className="py-2 font-medium">
              From SAP
            </th>
          </tr>
        </thead>
        <tbody className="text-[#111827]">
          <tr>
            <td className="break-words py-2 pr-3 align-top">
              <span className="text-[#6b5d50]">Code: </span>
              <span className="font-mono">
                {source?.vendorItemCode || "Not printed / extracted"}
              </span>
            </td>
            <td className="break-words py-2 align-top">
              <span className="text-[#6b5d50]">Code: </span>
              <span className="font-mono">
                {line.itemCode || "No item selected"}
              </span>
            </td>
          </tr>
          <tr className="border-t border-[#ece6dc]">
            <td className="break-words py-2 pr-3 align-top">
              <span className="text-[#6b5d50]">Name: </span>
              {source?.description || "Description not recorded"}
            </td>
            <td className="break-words py-2 align-top">
              <span className="text-[#6b5d50]">Name: </span>
              {line.itemName ||
                (line.itemCode
                  ? "Name not recorded"
                  : "Link an item to continue")}
            </td>
          </tr>
        </tbody>
      </table>
      {explanation ? (
        <p className="mt-2 text-[#6b5d50]">{explanation}</p>
      ) : null}
      {invoice.source ? (
        <p className="mt-1 text-[10px] text-[#6b5d50]">
          Invoice source:{" "}
          {[invoice.source.fileName, invoice.source.pageLabel]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
    </section>
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
  const balances = quantityBalances(line);
  const service = line.kind === "service";
  const amount = (value: number) =>
    service
      ? inr(value)
      : `${qty(value)}${invoice.lines[line.index]?.unit ? ` ${invoice.lines[line.index].unit}` : ""}`;
  const notices = [
    ...new Set(
      selected.flatMap((candidate) => [
        ...(!candidate.references
          ? [
              `${candidate.kind} ${candidate.docNum}: reference values were not recorded in this saved check.`,
            ]
          : []),
        ...candidateEvidence(invoice, candidate)
          .filter(
            (row) =>
              row.status !== "Matched" &&
              row.scanned !== "Not recorded" &&
              row.sap !== "Not recorded in saved check",
          )
          .map((row) => {
            const document = `${candidate.kind} ${candidate.docNum}`;
            if (row.status === "Partly matched")
              return `${document}: ${row.note?.replace(/^Matched:.*?\. /, "") ?? `${row.label} only partly matched.`}`;
            if (row.status === "Different")
              return `${row.label}: scanned ${row.scanned}; ${document} has ${row.sap}.`;
            return `${row.label} ${row.scanned}: not verified against ${document}${row.sap === "0" ? " (SAP stores 0)" : ""}.`;
          }),
      ]),
    ),
  ];
  return (
    <section>
      {notices.length ? (
        <ul
          aria-label="Reference checks to note"
          className="mb-2 space-y-1 border-l-2 border-[#d4c9bc] pl-2 text-[11px] leading-4 text-[#6b5d50]"
        >
          {notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      ) : null}
      <details className="text-[11px]">
        <summary className="w-fit cursor-pointer py-1 font-medium text-[#6b4a33]">
          Matching evidence
        </summary>
        <div className="mt-2 border-t border-[#ece6dc] pt-2">
          {invoice.source ? (
            <p className="mb-2 text-[11px] text-[#6b5d50]">
              Scanned invoice:{" "}
              {[invoice.source.fileName, invoice.source.pageLabel]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
          {selected.length ? (
            <dl className="mb-2 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
              {[
                ...(!service
                  ? [
                      ["GRPO Quantity received", balances.received],
                      ...(line.po?.qty != null
                        ? [["PO Quantity", line.po.qty]]
                        : []),
                    ]
                  : []),
                [
                  locked
                    ? "Open at saved check"
                    : service
                      ? "PO Open Amount"
                      : "GRPO Open Qty.",
                  balances.available,
                ],
                [locked ? "Used in draft" : "Allocated", balances.used],
                [
                  locked
                    ? "Remaining at saved check"
                    : "Remaining after allocation",
                  balances.remaining,
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-[#6b5d50]">{label}</dt>
                  <dd className="mt-0.5 font-medium text-[#111827]">
                    {amount(value as number)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          <div className="mb-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
            <h3 className="font-semibold text-[#111827]">How this matched</h3>
            <span className="text-[#6b5d50]">
              {itemIdentificationLabel(line)}
            </span>
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
                {candidate.kind} {candidate.docNum}, line{" "}
                {candidate.lineNum + 1}
                {candidate.kind === "GRPO"
                  ? candidate.purchaseOrder
                    ? ` → PO ${candidate.purchaseOrder.docNum ?? `Entry ${candidate.purchaseOrder.docEntry}`}${candidate.purchaseOrder.lineNum != null ? `, line ${candidate.purchaseOrder.lineNum + 1}` : " (line not recorded)"}`
                    : " → PO link not recorded in check"
                  : ""}
              </p>
              <CandidateEvidence invoice={invoice} candidate={candidate} />
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
