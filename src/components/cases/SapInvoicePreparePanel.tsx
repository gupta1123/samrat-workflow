"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  Loader2,
  Send,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-client";

type MatchedLine = {
  description: string | null;
  quantity: number | null;
  rate: number | null;
  matchConfidence: "exact" | "fuzzy" | "none";
  grpoItemCode: string | null;
  poRate: number | null;
  poQty: number | null;
  poItemCode: string | null;
  grpoRate: number | null;
  grpoQty: number | null;
};

type ApPayload = {
  documentType: string;
  vendor: { cardCode: string | null; cardName: string | null };
  baseGrpoDocNum: string | null;
  baseGrpoDocEntry: number | null;
  basePoDocNum: string | null;
  basePoDocEntry: number | null;
  poNumber: string | null;
  invoiceNumber: string | null;
  currency: string | null;
  invoiceDate: string | null;
  postingDate: string | null;
  caseId: string;
  caseName: string;
  lines: Array<{
    description: string | null;
    hsnSac: string | null;
    quantity: number | null;
    unit: string | null;
    rate: number | null;
    taxableAmount: number | null;
    taxAmount: number | null;
    baseGrpoLine: {
      docEntry: string | number;
      poLineNum: number;
      openQty: number | null;
    } | null;
  }>;
  totals: { taxable: number | null; tax: number | null; total: number | null };
};

type PrepareResult = {
  matched: boolean;
  caseStatus?: string;
  sapEnv?: string;
  reason?: string;
  sapDocument?: {
    kind: "PO" | "GRPO";
    docNum?: number;
    docEntry?: number;
    vendor?: string;
  };
  postedInvoice?: {
    docNum?: number;
    docEntry?: number;
    vendorReference?: string | null;
  } | null;
  sapPosting?: {
    status: "prepared" | "posted";
    documentNumber: string;
    postingDate?: string | null;
    invoiceDate?: string | null;
  } | null;
  baseSource?: "grpo" | "po";
  grpoDocNum?: string | number | null;
  poDocNum?: string | number | null;
  grpoVendor?: string | null;
  grpoLineCount?: number;
  poLineCount?: number;
  matchCount?: number;
  packetLineCount?: number;
  apPayload?: ApPayload;
  matchedLines?: MatchedLine[];
};

function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value);
}

function ConfidenceBadge({
  confidence,
}: {
  confidence: "exact" | "fuzzy" | "none";
}) {
  if (confidence === "exact") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#ebf5ee] px-2 py-0.5 text-[10px] font-medium text-[#1b4332]">
        <CheckCircle2 className="h-3 w-3" />
        Exact
      </span>
    );
  }
  if (confidence === "fuzzy") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#fef3c7] px-2 py-0.5 text-[10px] font-medium text-[#92400e]">
        Fuzzy
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#fee2e2] px-2 py-0.5 text-[10px] font-medium text-[#991b1b]">
      No match
    </span>
  );
}

export function SapInvoicePreparePanel({
  caseId,
  variant = "full",
}: {
  caseId: string;
  variant?: "full" | "sidebar";
}) {
  const [data, setData] = useState<PrepareResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [finalPosting, setFinalPosting] = useState(false);
  const [confirmingFinalPost, setConfirmingFinalPost] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiFetch(
        `/api/cases/${encodeURIComponent(caseId)}/sap-invoice-prepare`,
      );
      if (!response.ok) throw new Error("Failed");
      setData(await response.json());
    } catch {
      setData({ matched: false, reason: "error" });
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCopy() {
    if (!data?.apPayload) return;
    await navigator.clipboard.writeText(
      JSON.stringify(data.apPayload, null, 2),
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleSave() {
    if (!data?.apPayload) return;
    const base =
      data.baseSource === "po"
        ? {
            basePoDocNum: data.apPayload.basePoDocNum,
            basePoDocEntry: data.apPayload.basePoDocEntry,
          }
        : {
            baseGrpoDocNum: data.apPayload.baseGrpoDocNum,
            baseGrpoDocEntry: data.apPayload.baseGrpoDocEntry,
          };
    setSaving(true);
    setSaveResult(null);
    setSaveFailed(false);
    try {
      const response = await apiFetch(
        `/api/cases/${encodeURIComponent(caseId)}/sap-ap-draft`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(base),
        },
      );
      const body = await response.json().catch(() => ({}));
      setSaveFailed(!response.ok);
      if (response.ok) {
        setData((current) =>
          current?.apPayload
            ? {
                ...current,
                apPayload: {
                  ...current.apPayload,
                  postingDate:
                    typeof body.postingDate === "string"
                      ? body.postingDate
                      : current.apPayload.postingDate,
                },
                sapPosting:
                  body.draft && body.docEntry
                    ? {
                        status: "prepared",
                        documentNumber: String(body.docEntry),
                        postingDate:
                          typeof body.postingDate === "string"
                            ? body.postingDate
                            : current.apPayload.postingDate,
                        invoiceDate:
                          typeof body.invoiceDate === "string"
                            ? body.invoiceDate
                            : current.apPayload.invoiceDate,
                      }
                    : current.sapPosting,
              }
            : current,
        );
      }
      setSaveResult(
        response.ok
          ? (body.message ?? "SAP Test AP Invoice Draft created.")
          : (body.error ?? "Draft creation failed."),
      );
    } catch {
      setSaveFailed(true);
      setSaveResult("Could not create the SAP draft.");
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  }

  async function handleFinalPost() {
    if (!data?.sapPosting || data.sapPosting.status !== "prepared") return;
    setFinalPosting(true);
    setSaveResult(null);
    setSaveFailed(false);
    try {
      const response = await apiFetch(
        `/api/cases/${encodeURIComponent(caseId)}/sap-ap-draft/post`,
        { method: "POST" },
      );
      const body = await response.json().catch(() => ({}));
      setSaveFailed(!response.ok);
      setSaveResult(
        response.ok
          ? (body.message ?? "SAP Test AP Invoice posted successfully.")
          : (body.error ?? "Final SAP posting failed."),
      );
      if (response.ok && body.posted && body.docNum) {
        setData((current) =>
          current
            ? {
                ...current,
                sapPosting: {
                  status: "posted",
                  documentNumber: String(body.docNum),
                },
              }
            : current,
        );
      }
    } catch {
      setSaveFailed(true);
      setSaveResult("Could not post the final AP invoice in SAP Test.");
    } finally {
      setFinalPosting(false);
      setConfirmingFinalPost(false);
    }
  }

  if (loading) {
    if (variant === "sidebar") {
      return (
        <div className="flex items-center gap-2 px-4 py-4 text-xs text-[#8a7f72]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Matching with SAP…
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-xs text-[#8a7f72]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Matching with SAP…
      </div>
    );
  }

  if (!data?.matched || !data.apPayload) {
    const documentLabel = data?.sapDocument
      ? `${data.sapDocument.kind} ${data.sapDocument.docNum ?? "—"}`
      : "SAP document";
    const reasonMessages: Record<string, string> = {
      no_invoice: "No vendor invoice found in this case.",
      sap_unavailable:
        "Could not reach SAP. Check the connection and try again.",
      no_match:
        "No matching GRPO or Open PO found in SAP. Check vendor name and PO number.",
      unverified_po:
        "The PO returned by the legacy SAP list could not be verified in the SAP Test company.",
      no_line_match:
        "A vendor or document number was found, but none of the invoice lines matched. Review the SAP document before proceeding.",
      closed_po: `${documentLabel} exists in SAP Test but is closed. This check did not confirm a linked posted AP invoice; it cannot be used for a new draft.`,
      closed_grpo: `${documentLabel} exists in SAP Test but is closed. This check did not confirm a linked posted AP invoice; it cannot be used for a new draft.`,
      already_posted: `A posted SAP Test AP invoice ${data?.postedInvoice?.docNum ?? "—"} is linked to ${documentLabel}. SAP vendor reference: ${data?.postedInvoice?.vendorReference || "not recorded"}. Do not post this packet again.`,
      error: "Could not load SAP data. Try again.",
    };
    const message =
      reasonMessages[data?.reason ?? ""] ?? "No SAP match found for this case.";
    const title =
      data?.reason === "already_posted"
        ? "Already posted in SAP"
        : data?.reason === "closed_grpo"
          ? "GRPO found, but closed"
          : data?.reason === "closed_po"
            ? "PO found, but closed"
            : data?.reason === "no_line_match"
              ? "SAP lines do not match"
              : "No SAP match";
    if (variant === "sidebar") {
      return (
        <div className="px-4 py-4">
          <div className="text-[11px] font-medium text-[#3d3530]">{title}</div>
          <div className="mt-0.5 text-[11px] leading-4 text-[#8a7f72]">
            {message}
          </div>
        </div>
      );
    }
    return (
      <div className="px-4 py-6">
        <div className="flex items-start gap-2.5 rounded-lg border border-[#e0d8cc] bg-[#fbfaf8] px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#b45309]" />
          <div>
            <div className="text-[12px] font-semibold text-[#3d3530]">
              {title}
            </div>
            <div className="mt-0.5 text-[11px] text-[#8a7f72]">{message}</div>
          </div>
        </div>
      </div>
    );
  }

  const {
    apPayload,
    matchedLines,
    grpoDocNum,
    poDocNum,
    matchCount,
    packetLineCount,
  } = data;
  const baseSource = data.baseSource ?? "grpo";
  const baseDocNum = baseSource === "po" ? poDocNum : grpoDocNum;
  const baseLabel = baseSource === "po" ? "PO" : "GRPO";
  const sapPosting = data.sapPosting ?? null;
  const draftCreated = sapPosting?.status === "prepared";
  const canCreateDraft =
    data.caseStatus === "accepted" &&
    data.sapEnv === "test" &&
    Boolean(apPayload.postingDate) &&
    apPayload.totals.total !== null &&
    apPayload.totals.total > 0 &&
    (baseSource === "po"
      ? Boolean(apPayload.basePoDocNum && apPayload.basePoDocEntry)
      : Boolean(apPayload.baseGrpoDocNum && apPayload.baseGrpoDocEntry));

  if (variant === "sidebar") {
    return (
      <div className="flex items-center gap-1.5 px-4 py-3">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#2d6a4f]" />
        <span className="truncate text-[12px] font-semibold text-[#111827]">
          Matched to {baseLabel} {baseDocNum ?? "—"}
        </span>
        <span className="shrink-0 text-[11px] text-[#8a7f72]">
          · {matchCount}/{packetLineCount} lines matched
        </span>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-[#2d6a4f]" />
        <span className="text-[12px] font-semibold text-[#111827]">
          Matched to {baseLabel} {baseDocNum ?? "—"}
        </span>
        <span className="text-[11px] text-[#8a7f72]">
          · {matchCount}/{packetLineCount} lines matched
        </span>
      </div>

      {/* Two-column layout: Invoice (left) | SAP Match (right) */}
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        {/* LEFT: Invoice draft preview */}
        <div className="rounded-lg border border-[#e0d8cc] bg-white">
          <div className="border-b border-[#e0d8cc] bg-[#fbfaf8] px-4 py-2.5">
            <div className="text-[11px] font-semibold text-[#3d3530]">
              Invoice Draft Preview
            </div>
            <div className="text-[10px] text-[#8a7f72]">
              AP Invoice Draft → SAP Test
            </div>
          </div>

          <div className="p-4 space-y-3">
            {/* Vendor */}
            <div>
              <div className="text-[10px] font-medium text-[#8a7f72] uppercase tracking-wide">
                Vendor
              </div>
              <div className="text-[12px] font-semibold text-[#111827]">
                {apPayload.vendor.cardName ?? "—"}
              </div>
              {apPayload.vendor.cardCode && (
                <div className="text-[10px] text-[#8a7f72]">
                  Code: {apPayload.vendor.cardCode}
                </div>
              )}
            </div>

            {/* References */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[10px] font-medium text-[#8a7f72] uppercase tracking-wide">
                  Invoice #
                </div>
                <div className="text-[11px] font-medium text-[#111827]">
                  {apPayload.invoiceNumber ?? "—"}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-medium text-[#8a7f72] uppercase tracking-wide">
                  PO #
                </div>
                <div className="text-[11px] font-medium text-[#111827]">
                  {apPayload.poNumber ?? "—"}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-medium text-[#8a7f72] uppercase tracking-wide">
                  Currency
                </div>
                <div className="text-[11px] font-medium text-[#111827]">
                  {apPayload.currency ?? "—"}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-medium text-[#8a7f72] uppercase tracking-wide">
                  SAP Test posting date
                </div>
                <div className="text-[11px] font-medium text-[#111827]">
                  {apPayload.postingDate ?? "—"}
                </div>
              </div>
            </div>

            {/* Line Items */}
            <div>
              <div className="text-[10px] font-medium text-[#8a7f72] uppercase tracking-wide mb-2">
                Line Items
              </div>
              <div className="rounded border border-[#ece6dc] overflow-hidden">
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="bg-[#fbfaf8] text-[#8a7f72]">
                      <th className="px-2 py-1.5 text-left font-medium">
                        Item
                      </th>
                      <th className="px-2 py-1.5 text-right font-medium">
                        Qty
                      </th>
                      <th className="px-2 py-1.5 text-right font-medium">
                        Rate
                      </th>
                      <th className="px-2 py-1.5 text-right font-medium">
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {apPayload.lines.map((line, i) => (
                      <tr key={i} className="border-t border-[#f0ece4]">
                        <td className="px-2 py-1.5 text-[#111827]">
                          <div className="font-medium">
                            {line.description ?? "—"}
                          </div>
                          {line.hsnSac && (
                            <div className="text-[9px] text-[#8a7f72]">
                              HSN: {line.hsnSac}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right text-[#111827]">
                          {line.quantity ?? "—"} {line.unit ?? ""}
                        </td>
                        <td className="px-2 py-1.5 text-right text-[#111827]">
                          {formatMoney(line.rate)}
                        </td>
                        <td className="px-2 py-1.5 text-right font-medium text-[#111827]">
                          {formatMoney(line.taxableAmount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Totals */}
            <div className="rounded-lg bg-[#fbfaf8] p-3 space-y-1.5">
              <div className="flex justify-between text-[11px]">
                <span className="text-[#8a7f72]">Taxable</span>
                <span className="font-medium text-[#111827]">
                  {formatMoney(apPayload.totals.taxable)}
                </span>
              </div>
              <div className="flex justify-between text-[11px]">
                <span className="text-[#8a7f72]">Tax</span>
                <span className="font-medium text-[#111827]">
                  {formatMoney(apPayload.totals.tax)}
                </span>
              </div>
              <div className="flex justify-between text-[11px] border-t border-[#ece6dc] pt-1.5">
                <span className="font-semibold text-[#3d3530]">Total</span>
                <span className="font-semibold text-[#111827]">
                  {formatMoney(apPayload.totals.total)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT: SAP Match */}
        <div className="rounded-lg border border-[#e0d8cc] bg-white">
          <div className="border-b border-[#e0d8cc] bg-[#fbfaf8] px-4 py-2.5">
            <div className="text-[11px] font-semibold text-[#3d3530]">
              SAP Match
            </div>
            <div className="text-[10px] text-[#8a7f72]">
              {baseSource === "grpo"
                ? `GRPO DocNum: ${grpoDocNum ?? "—"}`
                : `PO DocNum: ${poDocNum ?? "—"}`}
            </div>
          </div>

          <div className="p-4 space-y-3">
            {/* Match Info */}
            <div className="flex items-center gap-3 p-3 rounded-lg bg-[#ebf5ee] border border-[#c3dfcb]">
              <ArrowRight className="h-4 w-4 text-[#1b4332]" />
              <div>
                <div className="text-[11px] font-semibold text-[#1b4332]">
                  Matched to {baseLabel} {baseDocNum ?? "—"}
                </div>
                <div className="text-[10px] text-[#2d6a4f]">
                  {matchCount} of {packetLineCount} lines matched
                </div>
              </div>
            </div>

            {/* SAP Document Info */}
            <div className="grid grid-cols-2 gap-3">
              {grpoDocNum && (
                <div>
                  <div className="text-[10px] font-medium text-[#8a7f72] uppercase tracking-wide">
                    GRPO #
                  </div>
                  <div className="text-[11px] font-medium text-[#111827]">
                    {grpoDocNum}
                  </div>
                </div>
              )}
              {poDocNum && (
                <div>
                  <div className="text-[10px] font-medium text-[#8a7f72] uppercase tracking-wide">
                    PO #
                  </div>
                  <div className="text-[11px] font-medium text-[#111827]">
                    {poDocNum}
                  </div>
                </div>
              )}
            </div>

            {/* Matched Lines Table */}
            {matchedLines && matchedLines.length > 0 && (
              <div>
                <div className="text-[10px] font-medium text-[#8a7f72] uppercase tracking-wide mb-2">
                  Line Matching
                </div>
                <div className="rounded border border-[#ece6dc] overflow-hidden">
                  <table className="w-full text-[10px]">
                    <thead>
                      <tr className="bg-[#fbfaf8] text-[#8a7f72]">
                        <th className="px-2 py-1.5 text-left font-medium">
                          Description
                        </th>
                        <th className="px-2 py-1.5 text-right font-medium">
                          Packet Qty
                        </th>
                        <th className="px-2 py-1.5 text-right font-medium">
                          SAP Qty
                        </th>
                        <th className="px-2 py-1.5 text-center font-medium">
                          Match
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {matchedLines.map((line, i) => {
                        const sapQty =
                          baseSource === "grpo" ? line.grpoQty : line.poQty;
                        const packetQty = line.quantity;
                        const hasMismatch =
                          packetQty != null &&
                          sapQty != null &&
                          Number(packetQty) !== Number(sapQty);

                        return (
                          <tr key={i} className="border-t border-[#f0ece4]">
                            <td className="px-2 py-1.5 text-[#111827] max-w-[150px] truncate">
                              {line.description ?? "—"}
                            </td>
                            <td
                              className={`px-2 py-1.5 text-right ${hasMismatch ? "text-[#b91c1c] font-semibold" : "text-[#111827]"}`}
                            >
                              {packetQty ?? "—"}
                            </td>
                            <td
                              className={`px-2 py-1.5 text-right ${hasMismatch ? "text-[#b91c1c] font-semibold" : "text-[#111827]"}`}
                            >
                              {sapQty ?? "—"}
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              <ConfidenceBadge
                                confidence={line.matchConfidence}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Confidence Summary */}
            <div className="rounded-lg bg-[#fbfaf8] p-3">
              <div className="text-[10px] font-medium text-[#8a7f72] uppercase tracking-wide mb-2">
                Match Summary
              </div>
              <div className="space-y-1.5">
                {matchedLines &&
                  (() => {
                    const exact = matchedLines.filter(
                      (l) => l.matchConfidence === "exact",
                    ).length;
                    const fuzzy = matchedLines.filter(
                      (l) => l.matchConfidence === "fuzzy",
                    ).length;
                    const none = matchedLines.filter(
                      (l) => l.matchConfidence === "none",
                    ).length;
                    return (
                      <>
                        {exact > 0 && (
                          <div className="flex items-center gap-2 text-[11px]">
                            <CheckCircle2 className="h-3.5 w-3.5 text-[#2d6a4f]" />
                            <span className="text-[#111827]">
                              {exact} exact match{exact !== 1 ? "es" : ""}
                            </span>
                          </div>
                        )}
                        {fuzzy > 0 && (
                          <div className="flex items-center gap-2 text-[11px]">
                            <div className="h-3.5 w-3.5 rounded-full bg-[#fef3c7] flex items-center justify-center">
                              <div className="h-1.5 w-1.5 rounded-full bg-[#92400e]" />
                            </div>
                            <span className="text-[#111827]">
                              {fuzzy} fuzzy match{fuzzy !== 1 ? "es" : ""}
                            </span>
                          </div>
                        )}
                        {none > 0 && (
                          <div className="flex items-center gap-2 text-[11px]">
                            <AlertTriangle className="h-3.5 w-3.5 text-[#b91c1c]" />
                            <span className="text-[#b91c1c]">
                              {none} unmatched
                            </span>
                          </div>
                        )}
                      </>
                    );
                  })()}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Actions */}
      {sapPosting ? (
        <div className="rounded-lg border border-[#c3dfcb] bg-[#ebf5ee] px-4 py-3 text-[#1b4332]">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="text-[12px] font-semibold">
                {draftCreated
                  ? "Draft created in SAP Test — not posted"
                  : "Final AP invoice posted in SAP"}
              </div>
              <div className="mt-0.5 text-[11px] leading-4">
                {draftCreated
                  ? `Draft ${sapPosting.documentNumber} is saved in SAP Test. It is not a final AP invoice.`
                  : `AP invoice ${sapPosting.documentNumber} has already been posted. Do not create or post it again.`}
              </div>
              {draftCreated ? (
                <>
                  <div className="mt-1 text-[11px] font-medium">
                    Next step: Review Draft {sapPosting.documentNumber}, then
                    post it as the final AP invoice when it is correct.
                  </div>
                  {confirmingFinalPost ? (
                    <div className="mt-3 rounded-md border border-[#d8c5b6] bg-white/70 p-3 text-[#3d3530]">
                      <div className="text-[11px] font-semibold">
                        Post Draft {sapPosting.documentNumber} as the final AP
                        invoice in SAP Test?
                      </div>
                      <div className="mt-0.5 text-[10px] leading-4 text-[#6b5f55]">
                        This creates a final accounting document in SAP Test. It
                        cannot be undone from this app.
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <Button
                          size="sm"
                          disabled={finalPosting}
                          onClick={() => void handleFinalPost()}
                        >
                          {finalPosting ? (
                            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                          ) : (
                            <Send className="mr-1.5 h-3 w-3" />
                          )}
                          Confirm final posting
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={finalPosting}
                          onClick={() => setConfirmingFinalPost(false)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      className="mt-3"
                      onClick={() => setConfirmingFinalPost(true)}
                    >
                      <Send className="mr-1.5 h-3 w-3" />
                      Post Draft {sapPosting.documentNumber} as Final AP Invoice
                    </Button>
                  )}
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : saveResult ? (
        <div
          className={`rounded-lg border px-3 py-2 text-[11px] ${saveFailed ? "border-[#fecaca] bg-[#fef2f2] text-[#b91c1c]" : "border-[#c3dfcb] bg-[#ebf5ee] text-[#1b4332]"}`}
        >
          {saveResult}
        </div>
      ) : null}
      {saveResult && saveFailed && sapPosting ? (
        <div className="rounded-lg border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-[11px] text-[#b91c1c]">
          {saveResult}
        </div>
      ) : null}
      {sapPosting ? null : data.caseStatus !== "accepted" ? (
        <p className="text-[11px] text-[#8a7f72]">
          Approve this case before creating an SAP draft.
        </p>
      ) : data.sapEnv !== "test" ? (
        <p className="text-[11px] text-[#b45309]">
          Draft creation is enabled only in SAP Test.
        </p>
      ) : !apPayload.postingDate ? (
        <p className="text-[11px] text-[#b45309]">
          A valid vendor invoice date that is not in the future is required for
          the SAP Test posting date.
        </p>
      ) : !canCreateDraft ? (
        <p className="text-[11px] text-[#b45309]">
          A verified open {baseLabel}, invoice total, and approved case are
          required for an AP Invoice Draft.
        </p>
      ) : confirming ? (
        <div className="flex items-center gap-2 text-[11px]">
          <span>
            Create an AP Invoice Draft in SAP Test from {baseLabel} {baseDocNum}
            ? No invoice will be posted.
          </span>
          <Button size="sm" disabled={saving} onClick={() => void handleSave()}>
            {saving ? (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            ) : (
              <Send className="mr-1.5 h-3 w-3" />
            )}
            Confirm draft
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </div>
      ) : null}
      {baseSource === "po" && canCreateDraft && !sapPosting ? (
        <p className="text-[11px] text-[#b45309]">
          This draft is based directly on a PO. Review goods receipt and
          inventory impact in SAP before posting the draft as a final invoice.
        </p>
      ) : null}
      {canCreateDraft && !sapPosting ? (
        <p className="text-[11px] text-[#8a7f72]">
          These are the extracted vendor invoice amounts. SAP calculates the
          draft from its base document; verify the draft rate, tax, and total
          before final posting.
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        {canCreateDraft && !confirming && !sapPosting ? (
          <Button
            size="sm"
            className="rounded-lg bg-[#2b1a10] text-[11px] font-medium text-white hover:bg-[#3b271a] shadow-sm"
            disabled={saving}
            onClick={() => setConfirming(true)}
          >
            <Send className="mr-1.5 h-3 w-3" />
            Create AP Invoice Draft in SAP Test
          </Button>
        ) : null}
        {!sapPosting ? (
          <Button
            size="sm"
            variant="outline"
            className="rounded-lg border-[#ded8d0] bg-[#fbfaf8] text-[11px] font-medium text-[#3d3530] shadow-sm"
            onClick={() => void handleCopy()}
          >
            {copied ? (
              <Check className="mr-1.5 h-3 w-3 text-[#1b4332]" />
            ) : (
              <Copy className="mr-1.5 h-3 w-3" />
            )}
            {copied ? "Copied" : "Copy draft details"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
