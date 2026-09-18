"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Loader2,
  Send,
} from "lucide-react";

import { Button } from "@/components/ui/button";

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
  poNumber: string | null;
  invoiceNumber: string | null;
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
    baseGrpoLine: { docEntry: string | number; poLineNum: number; openQty: number | null } | null;
  }>;
  totals: { taxable: number; tax: number };
};

type PrepareResult = {
  matched: boolean;
  reason?: string;
  grpoDocNum?: string | number;
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
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value);
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}/sap-invoice-prepare`);
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
    await navigator.clipboard.writeText(JSON.stringify(data.apPayload, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleSave() {
    if (!data?.apPayload) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}/sap-post`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseGrpoDocNum: data.apPayload.baseGrpoDocNum }),
      });
      const body = await response.json().catch(() => ({}));
      setSaveResult(
        response.ok || body.code === "SAP_CREATE_API_MISSING"
          ? "Payload saved."
          : body.error ?? "Save failed.",
      );
    } catch {
      setSaveResult("Could not save.");
    } finally {
      setSaving(false);
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
    const reasonMessages: Record<string, string> = {
      no_invoice: "No vendor invoice found in this case.",
      sap_unavailable: "Could not reach SAP. Check the connection and try again.",
      no_open_grpo: "No open GRPO documents found in SAP for this vendor.",
      no_match: "No GRPO matched this case. Check vendor name and PO number.",
      error: "Could not load SAP data. Try again.",
    };
    const message = reasonMessages[data?.reason ?? ""] ?? "No SAP match found for this case.";
    if (variant === "sidebar") {
      return (
        <div className="px-4 py-4">
          <div className="text-[11px] font-medium text-[#3d3530]">No SAP match</div>
          <div className="mt-0.5 text-[11px] leading-4 text-[#8a7f72]">{message}</div>
        </div>
      );
    }
    return (
      <div className="px-4 py-6">
        <div className="flex items-start gap-2.5 rounded-lg border border-[#e0d8cc] bg-[#fbfaf8] px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#b45309]" />
          <div>
            <div className="text-[12px] font-semibold text-[#3d3530]">No SAP match</div>
            <div className="mt-0.5 text-[11px] text-[#8a7f72]">{message}</div>
          </div>
        </div>
      </div>
    );
  }

  const { apPayload, matchedLines, grpoDocNum, poDocNum, matchCount, packetLineCount } = data;

  if (variant === "sidebar") {
    return (
      <div className="px-4 py-3 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#2d6a4f]" />
          <span className="truncate text-[12px] font-semibold text-[#111827]">
            GRPO {grpoDocNum}{poDocNum ? ` · PO ${poDocNum}` : ""}
          </span>
        </div>
        <div className="text-[11px] text-[#8a7f72]">
          {matchCount}/{packetLineCount} lines matched
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-[#2d6a4f]" />
        <span className="text-[12px] font-semibold text-[#111827]">
          GRPO {grpoDocNum}{poDocNum ? ` · PO ${poDocNum}` : ""}
        </span>
        <span className="text-[11px] text-[#8a7f72]">
          · {matchCount}/{packetLineCount} lines matched
        </span>
      </div>

      {/* Vendor + refs */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        <div>
          <span className="text-[#8a7f72]">Vendor</span>
          <div className="font-medium text-[#111827]">
            {apPayload.vendor.cardName ?? "—"}
            {apPayload.vendor.cardCode ? (
              <span className="ml-1 text-[#8a7f72]">({apPayload.vendor.cardCode})</span>
            ) : null}
          </div>
        </div>
        <div>
          <span className="text-[#8a7f72]">Invoice</span>
          <div className="font-medium text-[#111827]">{apPayload.invoiceNumber ?? "—"}</div>
        </div>
        <div>
          <span className="text-[#8a7f72]">PO</span>
          <div className="font-medium text-[#111827]">{apPayload.poNumber ?? "—"}</div>
        </div>
        <div>
          <span className="text-[#8a7f72]">Base GRPO</span>
          <div className="font-medium text-[#111827]">{apPayload.baseGrpoDocNum ?? "—"}</div>
        </div>
      </div>

      {/* 3-column comparison table */}
      {matchedLines && matchedLines.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-[#e0d8cc]">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-[#fbfaf8] text-[10px] font-semibold text-[#8a7f72]">
                <th className="px-2.5 py-1.5 text-left" rowSpan={2}>Description</th>
                <th className="px-2.5 py-1.5 text-center border-l border-[#ece6dc]" colSpan={2}>Packet</th>
                <th className="px-2.5 py-1.5 text-center border-l border-[#ece6dc]" colSpan={2}>PO {poDocNum ?? "—"}</th>
                <th className="px-2.5 py-1.5 text-center border-l border-[#ece6dc]" colSpan={2}>GRPO {grpoDocNum}</th>
              </tr>
              <tr className="bg-[#fbfaf8] text-[10px] font-semibold text-[#8a7f72]">
                <th className="px-2.5 py-1.5 text-right border-l border-[#ece6dc]">Qty</th>
                <th className="px-2.5 py-1.5 text-right">Rate</th>
                <th className="px-2.5 py-1.5 text-right border-l border-[#ece6dc]">Qty</th>
                <th className="px-2.5 py-1.5 text-right">Rate</th>
                <th className="px-2.5 py-1.5 text-right border-l border-[#ece6dc]">Open Qty</th>
                <th className="px-2.5 py-1.5 text-right">Rate</th>
              </tr>
            </thead>
            <tbody>
              {matchedLines.map((line, i) => {
                const packetQty = line.quantity;
                const packetRate = line.rate;
                const poQty = line.poQty;
                const poRate = line.poRate;
                const grpoQty = line.grpoQty;
                const grpoRate = line.grpoRate;
                const qtyMismatch = packetQty != null && poQty != null && Number(packetQty) !== Number(poQty);
                const rateMismatch = packetRate != null && poRate != null && Number(packetRate) !== Number(poRate);
                return (
                  <tr key={i} className="border-t border-[#f0ece4]">
                    <td className="px-2.5 py-1.5 text-[#111827] max-w-[180px] truncate font-medium">
                      {line.description ?? "—"}
                    </td>
                    <td className={`px-2.5 py-1.5 text-right border-l border-[#ece6dc] ${qtyMismatch ? "text-[#b91c1c] font-semibold" : "text-[#111827]"}`}>
                      {packetQty ?? "—"}
                    </td>
                    <td className={`px-2.5 py-1.5 text-right ${rateMismatch ? "text-[#b91c1c] font-semibold" : "text-[#111827]"}`}>
                      {formatMoney(packetRate)}
                    </td>
                    <td className={`px-2.5 py-1.5 text-right border-l border-[#ece6dc] ${qtyMismatch ? "text-[#b91c1c] font-semibold" : "text-[#111827]"}`}>
                      {poQty ?? "—"}
                    </td>
                    <td className={`px-2.5 py-1.5 text-right ${rateMismatch ? "text-[#b91c1c] font-semibold" : "text-[#111827]"}`}>
                      {formatMoney(poRate)}
                    </td>
                    <td className="px-2.5 py-1.5 text-right border-l border-[#ece6dc] text-[#111827]">
                      {grpoQty ?? "—"}
                    </td>
                    <td className="px-2.5 py-1.5 text-right text-[#111827]">
                      {formatMoney(grpoRate)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Totals */}
      <div className="flex items-center gap-4 text-[11px]">
        <div>
          <span className="text-[#8a7f72]">Taxable</span>
          <span className="ml-1 font-medium text-[#111827]">{formatMoney(apPayload.totals.taxable)}</span>
        </div>
        <div>
          <span className="text-[#8a7f72]">Tax</span>
          <span className="ml-1 font-medium text-[#111827]">{formatMoney(apPayload.totals.tax)}</span>
        </div>
        <div>
          <span className="text-[#8a7f72]">Total</span>
          <span className="ml-1 font-semibold text-[#111827]">{formatMoney(apPayload.totals.taxable + apPayload.totals.tax)}</span>
        </div>
      </div>

      {/* Actions */}
      {saveResult ? (
        <div className="rounded-lg border border-[#c3dfcb] bg-[#ebf5ee] px-3 py-2 text-[11px] text-[#1b4332]">
          {saveResult}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="rounded-lg bg-[#2b1a10] text-[11px] font-medium text-white hover:bg-[#3b271a] shadow-sm"
          disabled={saving}
          onClick={() => void handleSave()}
        >
          {saving ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Send className="mr-1.5 h-3 w-3" />}
          Save payload
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="rounded-lg border-[#ded8d0] bg-[#fbfaf8] text-[11px] font-medium text-[#3d3530] shadow-sm"
          onClick={() => void handleCopy()}
        >
          {copied ? <Check className="mr-1.5 h-3 w-3 text-[#1b4332]" /> : <Copy className="mr-1.5 h-3 w-3" />}
          {copied ? "Copied" : "Copy JSON"}
        </Button>
      </div>
    </div>
  );
}
