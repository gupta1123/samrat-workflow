"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, Send, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  fetchSapReadiness,
  postToSap,
  type SapReadiness,
} from "@/lib/sap-posting";

function kindLabel(kind: string): string {
  return kind === "GRN" ? "GRN (Goods Receipt)" : "AP Invoice";
}

export function SapPostingPanel({ caseId }: { caseId: string }) {
  const [readiness, setReadiness] = useState<SapReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [basePoDocNum, setBasePoDocNum] = useState<string>("");
  const [baseGrpoDocNum, setBaseGrpoDocNum] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReadiness(await fetchSapReadiness(caseId));
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Could not load SAP readiness.",
      );
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handlePost() {
    setPosting(true);
    setResult(null);
    try {
      const { ok, body } = await postToSap(caseId, {
        basePoDocNum: basePoDocNum || null,
        baseGrpoDocNum: baseGrpoDocNum || null,
      });
      if (ok) {
        setResult(
          typeof body.message === "string" && body.message
            ? body.message
            : "Posted to SAP successfully.",
        );
      } else if (body.code === "SAP_CREATE_API_MISSING") {
        setResult(
          typeof body.message === "string" && body.message
            ? body.message
            : "SAP create URLs are not configured yet.",
        );
      } else {
        setResult(
          typeof body.error === "string" && body.error
            ? body.error
            : "SAP posting failed.",
        );
      }
    } catch (postError) {
      setResult(
        postError instanceof Error ? postError.message : "SAP posting failed.",
      );
    } finally {
      setPosting(false);
      setConfirming(false);
      await load();
    }
  }

  if (loading) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-5">
        <p className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking SAP readiness…
        </p>
      </section>
    );
  }

  if (error || !readiness) {
    return (
      <section className="rounded-2xl border border-red-200 bg-red-50 p-5">
        <p className="text-sm text-red-700">{error ?? "SAP is unavailable."}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
          Retry
        </Button>
      </section>
    );
  }

  const { classification, postable } = readiness;
  const postedKinds = new Set(
    readiness.postings.filter((p) => p.status === "posted").map((p) => p.kind),
  );
  const remaining = classification.plan.filter((kind) => !postedKinds.has(kind));

  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-5"
      aria-label="SAP posting"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">
          Post to SAP
          <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-500">
            {readiness.sapEnv === "live" ? "Live" : "Test"}
          </span>
        </h2>
        {readiness.sapError ? (
          <span className="flex items-center gap-1 text-xs text-amber-600">
            <TriangleAlert className="h-3.5 w-3.5" /> SAP read failed — matching unavailable
          </span>
        ) : (
          <span className="text-xs text-slate-500">
            {readiness.openPoCount} open POs · {readiness.openGrpoCount} open GRPOs
          </span>
        )}
      </div>

      {classification.plan.length > 0 ? (
        <p className="mt-2 text-sm text-slate-600">
          Detected:{" "}
          <strong>
            {classification.plan.map(kindLabel).join(" + ")}
          </strong>{" "}
          {classification.poNumber ? (
            <>
              · PO <strong>{classification.poNumber}</strong>
              {readiness.matchedPoDocNum ? (
                <span className="text-emerald-600"> (matches SAP PO {readiness.matchedPoDocNum})</span>
              ) : (
                <span className="text-amber-600"> (no matching open SAP PO)</span>
              )}
            </>
          ) : null}
          {classification.invoiceNumber ? (
            <>
              {" "}· Invoice <strong>{classification.invoiceNumber}</strong>
            </>
          ) : null}
          {classification.receiptDocumentTypes.length > 0 ? (
            <span> · Receipt: {classification.receiptDocumentTypes.join(", ")}</span>
          ) : null}
        </p>
      ) : (
        <p className="mt-2 text-sm text-amber-700">{classification.blockedReason}</p>
      )}

      {!readiness.matchedPoDocNum &&
      readiness.candidatePOs.length > 0 &&
      remaining.includes("GRN") ? (
        <label className="mt-3 block text-sm text-slate-700">
          Base GRN on open SAP PO{" "}
          <span className="text-slate-400">
            (PO number {classification.poNumber} is not an SAP DocNum — pick the match)
          </span>
          <select
            className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
            value={basePoDocNum}
            onChange={(event) => setBasePoDocNum(event.target.value)}
          >
            <option value="">No base PO selected</option>
            {readiness.candidatePOs.map((candidate) => (
              <option key={candidate.docNum} value={candidate.docNum}>
                PO {candidate.docNum}
                {candidate.vendorName ? ` · ${candidate.vendorName}` : ""}
                {candidate.totalAmount !== null ? ` · ₹${candidate.totalAmount.toLocaleString("en-IN")}` : ""}
                {candidate.reasons.length ? ` (${candidate.reasons.join(", ")})` : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {!readiness.matchedGrpoDocNum &&
      readiness.candidateGRPOs.length > 0 &&
      remaining.includes("AP") ? (
        <label className="mt-3 block text-sm text-slate-700">
          Base AP invoice on open SAP GRPO{" "}
          <span className="text-slate-400">
            (pick the goods receipt this invoice bills)
          </span>
          <select
            className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
            value={baseGrpoDocNum}
            onChange={(event) => setBaseGrpoDocNum(event.target.value)}
          >
            <option value="">No base GRPO selected</option>
            {readiness.candidateGRPOs.map((candidate) => (
              <option key={candidate.docNum} value={candidate.docNum}>
                GRPO {candidate.docNum}
                {candidate.vendorName ? ` · ${candidate.vendorName}` : ""}
                {candidate.totalAmount !== null ? ` · ₹${candidate.totalAmount.toLocaleString("en-IN")}` : ""}
                {candidate.reasons.length ? ` (${candidate.reasons.join(", ")})` : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {!readiness.matchedPoDocNum &&
      !readiness.matchedGrpoDocNum &&
      readiness.candidatePOs.length === 0 &&
      readiness.candidateGRPOs.length === 0 &&
      !readiness.sapError &&
      classification.plan.length > 0 ? (
        <p className="mt-3 text-sm text-slate-500">
          No open SAP PO or GRPO resembles this packet (vendor{" "}
          {readiness.caseVendor || "unknown"}
          {readiness.caseTotal !== null ? `, total ₹${readiness.caseTotal.toLocaleString("en-IN")}` : ""}).
          The PO is likely already closed in SAP, or this {readiness.sapEnv} environment does not carry it.
          The prepared payload below is still saved and ready to send once the base document is known.
        </p>
      ) : null}

      {readiness.postings.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {readiness.postings.map((posting) => (
            <li key={`${posting.kind}-${posting.sap_env}`} className="flex items-center gap-2 text-sm">
              {posting.status === "posted" ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <TriangleAlert className="h-4 w-4 text-amber-500" />
              )}
              <span className="text-slate-700">
                {kindLabel(posting.kind)} — {posting.status}
                {posting.sap_docnum ? ` (SAP ${posting.sap_docnum})` : ""}
                {posting.error && posting.status !== "posted" ? `: ${posting.error}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {result ? <p className="mt-3 text-sm text-slate-700">{result}</p> : null}

      {!postable ? (
        <p className="mt-3 text-sm text-slate-500">
          SAP posting unlocks after the case is approved.
        </p>
      ) : remaining.length === 0 && classification.plan.length > 0 ? (
        <p className="mt-3 flex items-center gap-1 text-sm text-emerald-700">
          <CheckCircle2 className="h-4 w-4" /> Everything in this packet is already posted.
        </p>
      ) : classification.plan.length > 0 ? (
        confirming ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-sm text-slate-700">
              Create {remaining.map(kindLabel).join(" + ")} in SAP ({readiness.sapEnv})?
            </span>
            <Button size="sm" disabled={posting} onClick={() => void handlePost()}>
              {posting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Confirm posting
            </Button>
            <Button size="sm" variant="outline" disabled={posting} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="sm" className="mt-4" onClick={() => setConfirming(true)}>
            <Send className="h-3.5 w-3.5" />
            Create {remaining.map(kindLabel).join(" + ")} in SAP
          </Button>
        )
      ) : null}
    </section>
  );
}
