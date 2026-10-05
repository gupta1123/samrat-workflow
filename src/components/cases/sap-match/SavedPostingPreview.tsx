"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import type { PostedSapDetails } from "@/lib/sap-posted-details";
import {
  object,
  SAP_HEADER_FIELDS,
  type SapDocumentSnapshot,
} from "@/lib/sap-posting-preview";
import { PostingFieldGrid, SourceTag } from "./PostingFieldGrid";
import { formatDate, inr, qty } from "./format";

const numeric = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const scalar = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : null;

export function SavedPostingCard({
  caseId,
  details,
  posted = false,
}: {
  caseId: string;
  details: PostedSapDetails;
  posted?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const beforeTax = details.match?.result.payload?.bookedTaxable;
  return (
    <section className="overflow-hidden rounded-xl border border-[#e0d8cc] bg-white">
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[11px] font-medium text-[#6b4a33]">
          <span className="flex items-center gap-1.5">
            <ChevronDown
              className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
            {posted
              ? `Posted invoice details${details.bases.length ? ` · ${details.bases.map((base) => `${base.kind} ${base.number}`).join(", ")}` : ""}`
              : "Saved A/P Invoice Draft Preview"}
          </span>
          {!posted && beforeTax !== undefined ? (
            <span className="text-[10px] font-normal text-[#8a7f72]">
              Submitted before tax{" "}
              <span className="font-medium text-[#3d3530]">
                {inr(beforeTax)}
              </span>
            </span>
          ) : null}
        </summary>
        {expanded ? (
          <SavedPostingPreview
            caseId={caseId}
            details={details}
            posted={posted}
          />
        ) : null}
      </details>
    </section>
  );
}

/** Opening a preview reads SAP only; it never prepares or converts a draft. */
export function SavedPostingPreview({
  caseId,
  details,
  posted = false,
}: {
  caseId: string;
  details: PostedSapDetails;
  posted?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<SapDocumentSnapshot | null>(
    details.sapSnapshot ?? null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setSnapshot(details.sapSnapshot ?? null);
    setLoading(true);
    setError(null);
    apiFetch(
      `/api/cases/${encodeURIComponent(caseId)}/sap-match/posting-preview`,
      { cache: "no-store" },
    )
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not read SAP.");
        if (active) setSnapshot(body.snapshot);
      })
      .catch((error) => {
        if (active)
          setError(
            error instanceof Error ? error.message : "Could not read SAP.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [caseId, details.sapSnapshot]);
  const document = snapshot?.document ?? {};
  const fields = SAP_HEADER_FIELDS.map((field) => {
    const saved = details.headerFields?.find((row) => row.key === field.key);
    return {
      ...field,
      label: saved?.label ?? field.label,
      value:
        field.key in document
          ? scalar(document[field.key])
          : (saved?.value ?? null),
      source: field.key in document ? "SAP" : (saved?.source ?? "Saved"),
    };
  });
  const rows = Array.isArray(document.DocumentLines)
    ? document.DocumentLines.map(object)
    : [];
  const actualLines: Record<string, unknown>[] = rows.length
    ? rows
    : details.lines.map((line) => ({
        ItemCode: line.itemCode,
        ItemDescription: line.description,
        Quantity: line.quantity,
        UnitPrice: line.rate,
        LineTotal: line.amount,
      }));
  const planned = details.match?.result.payload;
  const beforeTax =
    rows.length && rows.every((row) => numeric(row.LineTotal) !== null)
      ? rows.reduce((sum, row) => sum + Number(row.LineTotal), 0)
      : null;
  const taxes = Array.isArray(document.WithholdingTaxDataCollection)
    ? document.WithholdingTaxDataCollection.map(object)
    : null;
  const withholding =
    taxes && taxes.every((row) => numeric(row.WTAmount) !== null)
      ? taxes.reduce((sum, row) => sum + Number(row.WTAmount), 0)
      : null;
  const transport = fields.filter((field) => field.group === "transport");
  const extra = [
    ["U_VEHNO", "Vehicle number"],
    ["U_LRNO", "Lorry Receipt number"],
    ["U_LRDT", "Lorry Receipt date"],
    ["U_WAYBNO", "E-Way Bill number"],
    ["U_WBTransId", "Weighbridge reference"],
    ["U_VEHTYPE", "Vehicle type"],
  ]
    .filter(([key]) => scalar(document[key]) && document[key] !== "")
    .map(([key, label]) => ({
      key,
      label,
      value: scalar(document[key]),
      source: "SAP",
    }));
  const docFields = [
    {
      key: "CardCode",
      label: "Supplier / BP code",
      value: [
        scalar(document.CardName) ?? details.vendorName,
        scalar(document.CardCode) ?? details.vendorCode,
      ]
        .filter(Boolean)
        .join(" · "),
      source: "SAP",
    },
    {
      key: "NumAtCard",
      label: "Vendor Ref. No.",
      value: scalar(document.NumAtCard) ?? details.invoiceNumber,
      source: "Saved",
    },
    {
      key: "DocDate",
      label: "Posting Date",
      value: scalar(document.DocDate) ?? details.postingDate,
      source: "Saved",
    },
    {
      key: "TaxDate",
      label: "Document Date",
      value: scalar(document.TaxDate) ?? details.invoiceDate,
      source: "Saved",
    },
    {
      key: "DocCurrency",
      label: "Currency",
      value: scalar(document.DocCurrency) ?? details.currency,
      source: "SAP",
    },
    {
      key: "DocEntry",
      label: posted ? "Invoice Entry No." : "Draft No. / Entry No.",
      value: posted
        ? scalar(document.DocEntry)
        : [
            scalar(document.DocNum) ?? details.draftDocNum,
            scalar(document.DocEntry) ?? details.draftNumber,
          ]
            .filter(Boolean)
            .join(" / "),
      source: "SAP",
    },
  ].map((field) => ({
    ...field,
    source: field.key in document ? "SAP" : "Saved",
  }));
  const currency =
    scalar(document.DocCurrency) ??
    details.currency ??
    details.match?.invoice.currency;
  const money = (value: number | null | undefined) =>
    value == null
      ? "—"
      : currency === "INR"
        ? inr(value)
        : `${currency ?? ""} ${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value)}`.trim();
  return (
    <div className="space-y-3 px-4 pb-3 text-[11px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[#ece6dc] pt-2 text-[10px] text-[#8a7f72]">
        {loading ? (
          <span className="flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Reading SAP…
          </span>
        ) : snapshot ? (
          <span>
            SAP read{" "}
            {new Date(snapshot.readAt).toLocaleString("en-IN", {
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        ) : (
          <span>Saved submission</span>
        )}
        {error ? (
          <span className="text-[#9a5a0a]">
            {error} Showing the available saved record.
          </span>
        ) : null}
      </div>
      <section>
        <h3 className="mb-2 text-[11px] font-semibold text-[#111827]">
          Document
        </h3>
        <PostingFieldGrid fields={docFields} />
        <div className="mt-1.5 text-[10px] text-[#8a7f72]">
          Base documents:{" "}
          {details.bases
            .map((base) => `${base.kind} ${base.number}`)
            .join(", ") || "Not recorded"}
        </div>
      </section>
      <section className="border-t border-[#ece6dc] pt-2">
        <h3 className="mb-2 text-[11px] font-semibold text-[#111827]">
          Transport & weights
        </h3>
        <PostingFieldGrid
          fields={transport.map(({ group, ...field }) => {
            void group;
            return field;
          })}
        />
      </section>
      <section className="border-t border-[#ece6dc] pt-2">
        <h3 className="mb-1 text-[11px] font-semibold text-[#111827]">
          Items
          <SourceTag source={rows.length ? "SAP" : "Saved"} />
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-[11px]">
            <thead className="border-b border-[#ece6dc] text-[10px] text-[#8a7f72]">
              <tr>
                {[
                  "Item",
                  "Base line",
                  "Quantity",
                  "Unit price",
                  "Before tax",
                ].map((label, index) => (
                  <th
                    key={label}
                    className={`py-1.5 font-medium ${index > 1 ? "text-right" : ""}`}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {actualLines.length ? (
                actualLines.map((line, index) => (
                  <tr
                    key={index}
                    className="border-b border-[#f0ece4] last:border-0"
                  >
                    <td className="py-1.5 pr-3">
                      <span>
                        {scalar(line.ItemDescription) ??
                          scalar(line.ItemCode) ??
                          "Service"}
                      </span>
                      <span className="ml-1.5 font-mono text-[10px] text-[#8a7f72]">
                        {scalar(line.ItemCode)}
                      </span>
                    </td>
                    <td className="py-1.5 text-[10px] text-[#8a7f72]">
                      {numeric(line.BaseEntry) !== null
                        ? `${line.BaseType === 20 ? "GRPO" : "PO"} ${details.match?.result.baseDocuments.find((base) => base.docEntry === line.BaseEntry)?.docNum ?? `Entry ${line.BaseEntry}`} · line ${Number(line.BaseLine) + 1}`
                        : "—"}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {qty(numeric(line.Quantity))}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {money(numeric(line.UnitPrice) ?? numeric(line.Price))}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {money(numeric(line.LineTotal))}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="py-2 text-[#8a7f72]">
                    Item details were not recorded. Open SAP payload for the
                    saved allocation.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <section className="grid gap-3 border-t border-[#ece6dc] pt-2 sm:grid-cols-2">
        <div>
          <h3 className="mb-1 text-[11px] font-semibold text-[#111827]">
            Amounts
            <SourceTag source={snapshot ? "SAP" : "Saved"} />
          </h3>
          <dl className="space-y-1 tabular-nums">
            {[
              ["Items before tax", beforeTax],
              ["GST", numeric(document.VatSum)],
              ["Withholding tax (TDS)", withholding],
              ["Round off", numeric(document.RoundingDiffAmount)],
              [
                "Net payable / SAP DocTotal",
                numeric(document.DocTotal) ?? details.netPayable,
              ],
            ].map(([label, value]) => (
              <div key={String(label)} className="flex justify-between gap-3">
                <dt className="text-[#8a7f72]">{label}</dt>
                <dd
                  className={
                    String(label).startsWith("Net")
                      ? "font-semibold text-[#111827]"
                      : "text-[#3d3530]"
                  }
                >
                  {money(typeof value === "number" ? value : null)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        {planned ? (
          <div>
            <h3 className="mb-1 text-[11px] font-semibold text-[#111827]">
              Submitted comparison
              <SourceTag source="Saved" />
            </h3>
            <dl className="space-y-1 tabular-nums">
              <div className="flex justify-between gap-3">
                <dt className="text-[#8a7f72]">Draft before tax</dt>
                <dd>{money(planned.bookedTaxable)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-[#8a7f72]">Scanned invoice before tax</dt>
                <dd>{money(planned.invoiceTaxable)}</dd>
              </div>
              {planned.freightExpense ? (
                <div className="flex justify-between">
                  <dt>Freight included</dt>
                  <dd>{money(planned.freightExpense)}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        ) : null}
      </section>
      {extra.length ? (
        <details className="border-t border-[#ece6dc] pt-2">
          <summary className="cursor-pointer text-[10px] font-medium text-[#6b4a33]">
            Additional transport details
          </summary>
          <div className="pt-2">
            <PostingFieldGrid fields={extra} sap />
          </div>
        </details>
      ) : null}
      <details className="border-t border-[#ece6dc] pt-2">
        <summary className="cursor-pointer text-[10px] font-medium text-[#6b4a33]">
          SAP payload
        </summary>
        <div className="space-y-2 pt-2">
          {fields
            .filter((field) => field.group === "document")
            .map((field) => (
              <div key={field.key} className="text-[10px]">
                <span className="font-mono text-[#8a7f72]">{field.key}</span> ·{" "}
                {field.key.endsWith("DT")
                  ? formatDate(String(field.value ?? "").slice(0, 10))
                  : (field.value ?? "Not recorded")}
                <SourceTag source={field.source === "SAP" ? "SAP" : "Saved"} />
              </div>
            ))}
          {details.submittedPayload ? (
            <details>
              <summary className="cursor-pointer">
                Submitted draft request
              </summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-[#faf8f5] p-2 text-[10px]">
                {JSON.stringify(details.submittedPayload, null, 2)}
              </pre>
            </details>
          ) : (
            <p className="text-[10px] text-[#8a7f72]">
              The complete request was not recorded for this older draft.
            </p>
          )}
          {snapshot ? (
            <details>
              <summary className="cursor-pointer">SAP document fields</summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-[#faf8f5] p-2 text-[10px]">
                {JSON.stringify(snapshot.document, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      </details>
    </div>
  );
}
