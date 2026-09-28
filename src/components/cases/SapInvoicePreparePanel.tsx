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
  quantity: string | number | null;
  rate: string | number | null;
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
    quantity: string | number | null;
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

type MaterialFormConfig = {
  fieldName: string;
  propertyName: string;
  description: string;
  selectedValue?: string;
  options: Array<{ value: string; label: string }>;
};

function formatMoney(
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(numericValue);
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatQuantity(
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) return "—";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 }).format(
    numericValue,
  );
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
  const [loadingFinalPostOptions, setLoadingFinalPostOptions] = useState(false);
  const [materialForm, setMaterialForm] = useState<MaterialFormConfig | null>(
    null,
  );
  const [selectedMaterialForm, setSelectedMaterialForm] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiFetch(
        `/api/cases/${encodeURIComponent(caseId)}/sap-invoice-prepare`,
        { cache: "no-store" },
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
    setCopied(false);
    setSaving(false);
    setSaveResult(null);
    setSaveFailed(false);
    setConfirming(false);
    setFinalPosting(false);
    setConfirmingFinalPost(false);
    setLoadingFinalPostOptions(false);
    setMaterialForm(null);
    setSelectedMaterialForm("");
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
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            materialForm
              ? { materialForm: selectedMaterialForm }
              : {},
          ),
        },
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
        setConfirmingFinalPost(false);
      }
    } catch {
      setSaveFailed(true);
      setSaveResult("Could not post the final AP invoice in SAP Test.");
    } finally {
      setFinalPosting(false);
    }
  }

  async function openFinalPostConfirmation() {
    setLoadingFinalPostOptions(true);
    setSaveResult(null);
    setSaveFailed(false);
    try {
      const response = await apiFetch(
        `/api/cases/${encodeURIComponent(caseId)}/sap-ap-draft/post`,
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSaveFailed(true);
        setSaveResult(body.error ?? "Could not verify the SAP Test draft.");
        setConfirmingFinalPost(false);
        setMaterialForm(null);
        setSelectedMaterialForm("");
        return;
      }
      if (body.readyForFinalPosting !== true) {
        setSaveFailed(true);
        setSaveResult(
          "SAP Test did not complete every final-posting check. No final invoice was posted.",
        );
        setConfirmingFinalPost(false);
        setMaterialForm(null);
        setSelectedMaterialForm("");
        return;
      }
      const config = body.materialForm as MaterialFormConfig | null;
      if (
        config &&
        (!Array.isArray(config.options) || config.options.length === 0)
      ) {
        setSaveFailed(true);
        setSaveResult(
          "SAP Test did not provide the allowed Material Form choices. No final invoice was posted.",
        );
        return;
      }
      setMaterialForm(config);
      setSelectedMaterialForm(
        config?.options.some((option) => option.value === config.selectedValue)
          ? (config.selectedValue ?? "")
          : "",
      );
      setConfirmingFinalPost(true);
    } catch {
      setSaveFailed(true);
      setSaveResult("Could not verify the SAP Test draft.");
    } finally {
      setLoadingFinalPostOptions(false);
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

  const lineStats = {
    exact: matchedLines?.filter((l) => l.matchConfidence === "exact").length ?? 0,
    fuzzy: matchedLines?.filter((l) => l.matchConfidence === "fuzzy").length ?? 0,
    none: matchedLines?.filter((l) => l.matchConfidence === "none").length ?? 0,
  };
  const matchPercent =
    packetLineCount && matchCount != null
      ? Math.min(100, Math.round((matchCount / packetLineCount) * 100))
      : 0;
  const documentStatus = sapPosting
    ? sapPosting.status === "posted"
      ? { label: "Posted", tone: "bg-[#ebf5ee] text-[#1b4332] ring-[#c3dfcb]" }
      : { label: "Draft saved", tone: "bg-[#eef2fb] text-[#1e3a8a] ring-[#cdd8f1]" }
    : { label: "Preview", tone: "bg-[#f4efe7] text-[#6b5d50] ring-[#e0d8cc]" };

  return (
    <div className="space-y-4 px-4 py-3">
      {/* Summary strip */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-[#e0d8cc] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(43,26,16,0.04)]">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#ebf5ee]">
            <CheckCircle2 className="h-4 w-4 text-[#2d6a4f]" />
          </span>
          <div>
            <div className="text-[13px] font-semibold text-[#111827]">
              Matched to {baseLabel} {baseDocNum ?? "—"}
            </div>
            <div className="text-[11px] text-[#8a7f72]">
              {apPayload.vendor.cardName ?? "Unknown vendor"}
            </div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="hidden w-36 sm:block">
            <div className="flex justify-between text-[10px] text-[#8a7f72]">
              <span>Lines matched</span>
              <span className="font-semibold tabular-nums text-[#3d3530]">
                {matchCount ?? 0}/{packetLineCount ?? 0}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#f0ece4]">
              <div
                className={`h-full rounded-full ${matchPercent === 100 ? "bg-[#2d6a4f]" : "bg-[#d97706]"}`}
                style={{ width: `${matchPercent}%` }}
              />
            </div>
          </div>
          <span className="rounded-full bg-[#fff7ed] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#b45309] ring-1 ring-inset ring-[#fcd9b6]">
            SAP {data.sapEnv === "test" ? "Test" : (data.sapEnv ?? "—")}
          </span>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        {/* LEFT: Invoice document preview */}
        <article className="overflow-hidden rounded-xl border border-[#e0d8cc] bg-white shadow-[0_1px_3px_rgba(43,26,16,0.06),0_8px_24px_-12px_rgba(43,26,16,0.12)]">
          <div className="h-1 bg-gradient-to-r from-[#2b1a10] via-[#6b4a33] to-[#c9a57f]" />

          {/* Document header */}
          <header className="flex flex-wrap items-start justify-between gap-4 px-6 pb-5 pt-5">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8a7f72]">
                Accounts Payable
              </div>
              <h2 className="mt-1 text-[20px] font-semibold tracking-tight text-[#111827]">
                A/P Invoice
              </h2>
              <span
                className={`mt-2 inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ring-inset ${documentStatus.tone}`}
              >
                {documentStatus.label}
                {sapPosting ? ` · #${sapPosting.documentNumber}` : ""}
              </span>
            </div>
            <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-right text-[11px]">
              <dt className="text-[#8a7f72]">Vendor ref.</dt>
              <dd className="font-semibold tabular-nums text-[#111827]">
                {apPayload.invoiceNumber ?? "—"}
              </dd>
              <dt className="text-[#8a7f72]">Invoice date</dt>
              <dd className="font-medium tabular-nums text-[#111827]">
                {formatDate(apPayload.invoiceDate)}
              </dd>
              <dt className="text-[#8a7f72]">Posting date</dt>
              <dd className="font-medium tabular-nums text-[#111827]">
                {formatDate(apPayload.postingDate)}
              </dd>
            </dl>
          </header>

          {/* Parties & references */}
          <div className="grid gap-px border-y border-[#ece6dc] bg-[#ece6dc] sm:grid-cols-2">
            <div className="bg-[#fcfbf9] px-6 py-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8a7f72]">
                Vendor
              </div>
              <div className="mt-1.5 text-[13px] font-semibold leading-5 text-[#111827]">
                {apPayload.vendor.cardName ?? "—"}
              </div>
              {apPayload.vendor.cardCode ? (
                <div className="mt-1 inline-flex rounded bg-[#f4efe7] px-1.5 py-0.5 font-mono text-[10px] text-[#6b5d50]">
                  {apPayload.vendor.cardCode}
                </div>
              ) : null}
            </div>
            <div className="bg-[#fcfbf9] px-6 py-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8a7f72]">
                Based on
              </div>
              <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                {grpoDocNum ? (
                  <>
                    <dt className="text-[#8a7f72]">GRPO</dt>
                    <dd className="font-medium tabular-nums text-[#111827]">{grpoDocNum}</dd>
                  </>
                ) : null}
                <dt className="text-[#8a7f72]">PO</dt>
                <dd className="font-medium tabular-nums text-[#111827]">
                  {poDocNum ?? apPayload.poNumber ?? "—"}
                </dd>
                <dt className="text-[#8a7f72]">Currency</dt>
                <dd className="font-medium text-[#111827]">{apPayload.currency ?? "INR"}</dd>
              </dl>
            </div>
          </div>

          {/* Line items */}
          <div className="overflow-x-auto px-6 pt-4">
            <table className="w-full min-w-[520px] text-[11px]">
              <thead>
                <tr className="border-b border-[#e0d8cc] text-[10px] uppercase tracking-wider text-[#8a7f72]">
                  <th className="w-8 py-2 pr-2 text-left font-semibold">#</th>
                  <th className="py-2 pr-3 text-left font-semibold">Item</th>
                  <th className="py-2 pl-3 text-right font-semibold">Qty</th>
                  <th className="py-2 pl-3 text-right font-semibold">Rate</th>
                  <th className="py-2 pl-3 text-right font-semibold">Taxable</th>
                  <th className="py-2 pl-3 text-right font-semibold">Tax</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {apPayload.lines.map((line, i) => (
                  <tr key={i} className="border-b border-[#f0ece4] align-top last:border-0">
                    <td className="py-3 pr-2 text-[#b3a899]">{String(i + 1).padStart(2, "0")}</td>
                    <td className="py-3 pr-3">
                      <div className="font-medium leading-4 text-[#111827]">
                        {line.description ?? "—"}
                      </div>
                      {line.hsnSac ? (
                        <div className="mt-0.5 text-[10px] text-[#8a7f72]">HSN/SAC {line.hsnSac}</div>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap py-3 pl-3 text-right text-[#111827]">
                      {formatQuantity(line.quantity)}
                      {line.unit ? <span className="ml-1 text-[10px] text-[#8a7f72]">{line.unit}</span> : null}
                    </td>
                    <td className="whitespace-nowrap py-3 pl-3 text-right text-[#3d3530]">
                      {formatMoney(line.rate)}
                    </td>
                    <td className="whitespace-nowrap py-3 pl-3 text-right font-medium text-[#111827]">
                      {formatMoney(line.taxableAmount)}
                    </td>
                    <td className="whitespace-nowrap py-3 pl-3 text-right text-[#3d3530]">
                      {formatMoney(line.taxAmount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="flex justify-end px-6 pb-5 pt-3">
            <dl className="w-full max-w-[280px] space-y-1.5 text-[11px] tabular-nums">
              <div className="flex justify-between">
                <dt className="text-[#8a7f72]">Taxable value</dt>
                <dd className="font-medium text-[#111827]">{formatMoney(apPayload.totals.taxable)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[#8a7f72]">Tax (GST)</dt>
                <dd className="font-medium text-[#111827]">{formatMoney(apPayload.totals.tax)}</dd>
              </div>
              <div className="mt-2 flex items-baseline justify-between rounded-lg bg-[#2b1a10] px-3 py-2.5 text-white">
                <dt className="text-[11px] font-medium uppercase tracking-wider text-[#e8dccd]">Total</dt>
                <dd className="text-[16px] font-semibold">{formatMoney(apPayload.totals.total)}</dd>
              </div>
            </dl>
          </div>

          <footer className="border-t border-dashed border-[#e0d8cc] bg-[#fcfbf9] px-6 py-2.5 text-[10px] leading-4 text-[#8a7f72]">
            Case {apPayload.caseName} · Values extracted from the vendor invoice. SAP recalculates from the base {baseLabel}.
          </footer>
        </article>

        {/* RIGHT: SAP match */}
        <aside className="flex flex-col overflow-hidden rounded-xl border border-[#e0d8cc] bg-white shadow-[0_1px_2px_rgba(43,26,16,0.04)]">
          <div className="border-b border-[#ece6dc] px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="text-[12px] font-semibold text-[#111827]">SAP line match</div>
              <span className="inline-flex items-center gap-1 text-[10px] font-medium text-[#6b5d50]">
                {apPayload.invoiceNumber ?? "Invoice"}
                <ArrowRight className="h-3 w-3" />
                {baseLabel} {baseDocNum ?? "—"}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {(
                [
                  ["Exact", lineStats.exact, "text-[#1b4332]", "bg-[#f3faf5]"],
                  ["Fuzzy", lineStats.fuzzy, "text-[#92400e]", "bg-[#fffbeb]"],
                  ["Unmatched", lineStats.none, "text-[#991b1b]", "bg-[#fef5f5]"],
                ] as const
              ).map(([label, count, text, bg]) => (
                <div key={label} className={`rounded-lg px-2.5 py-2 ${bg}`}>
                  <div className={`text-[16px] font-semibold tabular-nums leading-none ${text}`}>{count}</div>
                  <div className="mt-1 text-[10px] text-[#8a7f72]">{label}</div>
                </div>
              ))}
            </div>
          </div>

          {matchedLines && matchedLines.length > 0 ? (
            <ul className="divide-y divide-[#f0ece4]">
              {matchedLines.map((line, i) => {
                const sapQty = baseSource === "grpo" ? line.grpoQty : line.poQty;
                const sapRate = baseSource === "grpo" ? line.grpoRate : line.poRate;
                const itemCode = baseSource === "grpo" ? line.grpoItemCode : line.poItemCode;
                const qtyMismatch =
                  line.quantity != null && sapQty != null && Number(line.quantity) !== Number(sapQty);
                const rateMismatch =
                  line.rate != null && sapRate != null && Math.abs(Number(line.rate) - Number(sapRate)) > 0.01;
                return (
                  <li key={i} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[11px] font-medium text-[#111827]" title={line.description ?? undefined}>
                          {line.description ?? "—"}
                        </div>
                        {itemCode ? (
                          <div className="mt-0.5 font-mono text-[10px] text-[#8a7f72]">{itemCode}</div>
                        ) : null}
                      </div>
                      <ConfidenceBadge confidence={line.matchConfidence} />
                    </div>
                    <div className="mt-2 grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-0.5 text-[10px] tabular-nums">
                      <span />
                      <span className="text-right text-[#b3a899]">Invoice</span>
                      <span className="text-right text-[#b3a899]">SAP {baseLabel}</span>
                      <span className="text-[#8a7f72]">Qty</span>
                      <span className={`text-right ${qtyMismatch ? "font-semibold text-[#b91c1c]" : "text-[#111827]"}`}>
                        {formatQuantity(line.quantity)}
                      </span>
                      <span className={`text-right ${qtyMismatch ? "font-semibold text-[#b91c1c]" : "text-[#111827]"}`}>
                        {formatQuantity(sapQty)}
                      </span>
                      <span className="text-[#8a7f72]">Rate</span>
                      <span className={`text-right ${rateMismatch ? "font-semibold text-[#b45309]" : "text-[#111827]"}`}>
                        {formatMoney(line.rate)}
                      </span>
                      <span className={`text-right ${rateMismatch ? "font-semibold text-[#b45309]" : "text-[#111827]"}`}>
                        {formatMoney(sapRate)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="px-4 py-6 text-center text-[11px] text-[#8a7f72]">No line-level match details.</div>
          )}
        </aside>
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
                      {materialForm ? (
                        <label className="mt-3 block text-[10px] font-semibold text-[#3d3530]">
                          {materialForm.description}
                          <select
                            className="mt-1 block h-9 w-full rounded-md border border-[#cfc4b8] bg-white px-2 text-[11px] font-normal text-[#111827] outline-none focus:border-[#2d6a4f] focus:ring-1 focus:ring-[#2d6a4f]"
                            value={selectedMaterialForm}
                            disabled={finalPosting}
                            onChange={(event) => {
                              setSelectedMaterialForm(event.target.value);
                              setSaveResult(null);
                              setSaveFailed(false);
                            }}
                          >
                            <option value="">Select material form</option>
                            {materialForm.options.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label} ({option.value})
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                      <div className="mt-2 flex items-center gap-2">
                        <Button
                          size="sm"
                          disabled={
                            finalPosting ||
                            Boolean(materialForm && !selectedMaterialForm)
                          }
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
                      disabled={loadingFinalPostOptions}
                      onClick={() => void openFinalPostConfirmation()}
                    >
                      {loadingFinalPostOptions ? (
                        <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                      ) : (
                        <Send className="mr-1.5 h-3 w-3" />
                      )}
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
