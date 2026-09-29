"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-client";

type MaterialFormConfig = {
  fieldName: string;
  propertyName: string;
  description: string;
  selectedValue?: string;
  options: Array<{ value: string; label: string }>;
};

// The saved-draft and final-post steps. The server re-checks the draft against
// the case (vendor, dates, total, base documents) before anything is posted.
export function FinalPostSection({
  caseId,
  status,
  documentNumber,
  onChanged,
}: {
  caseId: string;
  status: "prepared" | "posted";
  documentNumber: string;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [checking, setChecking] = useState(false);
  const [posting, setPosting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [materialForm, setMaterialForm] = useState<MaterialFormConfig | null>(null);
  const [selectedMaterialForm, setSelectedMaterialForm] = useState("");

  if (status === "posted") {
    return (
      <div className="rounded-lg border border-[#c3dfcb] bg-[#ebf5ee] px-4 py-3 text-[#1b4332]">
        <div className="flex items-start gap-2.5">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="text-[12px] font-semibold">Final AP invoice posted in SAP</div>
            <div className="mt-0.5 text-[11px] leading-4">
              AP invoice {documentNumber} has been posted. Do not create or post it again.
            </div>
          </div>
        </div>
      </div>
    );
  }

  async function openConfirmation() {
    setChecking(true);
    setMessage(null);
    setFailed(false);
    try {
      const response = await apiFetch(`/api/cases/${encodeURIComponent(caseId)}/sap-ap-draft/post`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFailed(true);
        setMessage(body.error ?? "Could not verify the SAP Test draft.");
        setConfirming(false);
        return;
      }
      if (body.readyForFinalPosting !== true) {
        setFailed(true);
        setMessage("SAP Test did not complete every final-posting check. No final invoice was posted.");
        setConfirming(false);
        return;
      }
      const config = body.materialForm as MaterialFormConfig | null;
      if (config && (!Array.isArray(config.options) || config.options.length === 0)) {
        setFailed(true);
        setMessage("SAP Test did not provide the allowed Material Form choices. No final invoice was posted.");
        return;
      }
      setMaterialForm(config);
      setSelectedMaterialForm(
        config?.options.some((option) => option.value === config.selectedValue)
          ? (config.selectedValue ?? "")
          : "",
      );
      setConfirming(true);
    } catch {
      setFailed(true);
      setMessage("Could not verify the SAP Test draft.");
    } finally {
      setChecking(false);
    }
  }

  async function post() {
    setPosting(true);
    setMessage(null);
    setFailed(false);
    try {
      const response = await apiFetch(`/api/cases/${encodeURIComponent(caseId)}/sap-ap-draft/post`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(materialForm ? { materialForm: selectedMaterialForm } : {}),
      });
      const body = await response.json().catch(() => ({}));
      setFailed(!response.ok);
      setMessage(
        response.ok
          ? (body.message ?? "SAP Test AP Invoice posted successfully.")
          : (body.error ?? "Final SAP posting failed."),
      );
      if (response.ok && body.posted && body.docNum) {
        setConfirming(false);
        onChanged();
      }
    } catch {
      setFailed(true);
      setMessage("Could not post the final AP invoice in SAP Test.");
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="rounded-lg border border-[#c3dfcb] bg-[#ebf5ee] px-4 py-3 text-[#1b4332]">
      <div className="flex items-start gap-2.5">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold">Draft created in SAP Test, not posted</div>
          <div className="mt-0.5 text-[11px] leading-4">
            Draft {documentNumber} is saved in SAP Test. It is not a final AP invoice.
          </div>
          <div className="mt-1 text-[11px] font-medium">
            Next step: review Draft {documentNumber} in SAP, then post it as the final AP invoice when it is correct.
          </div>
          {confirming ? (
            <div className="mt-3 rounded-md border border-[#d8c5b6] bg-white/70 p-3 text-[#3d3530]">
              <div className="text-[11px] font-semibold">
                Post Draft {documentNumber} as the final AP invoice in SAP Test?
              </div>
              <div className="mt-0.5 text-[10px] leading-4 text-[#6b5f55]">
                This creates a final accounting document in SAP Test. It cannot be undone from this app.
              </div>
              {materialForm ? (
                <label className="mt-3 block text-[10px] font-semibold text-[#3d3530]">
                  {materialForm.description}
                  <select
                    className="mt-1 block h-9 w-full rounded-md border border-[#cfc4b8] bg-white px-2 text-[11px] font-normal text-[#111827] outline-none focus:border-[#2d6a4f] focus:ring-1 focus:ring-[#2d6a4f]"
                    value={selectedMaterialForm}
                    disabled={posting}
                    onChange={(event) => {
                      setSelectedMaterialForm(event.target.value);
                      setMessage(null);
                      setFailed(false);
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
                  disabled={posting || Boolean(materialForm && !selectedMaterialForm)}
                  onClick={() => void post()}
                >
                  {posting ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Send className="mr-1.5 h-3 w-3" />}
                  Confirm final posting
                </Button>
                <Button size="sm" variant="outline" disabled={posting} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" className="mt-3" disabled={checking} onClick={() => void openConfirmation()}>
              {checking ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Send className="mr-1.5 h-3 w-3" />}
              Post Draft {documentNumber} as Final AP Invoice
            </Button>
          )}
          {message ? (
            <div
              className={`mt-3 rounded-md border px-3 py-2 text-[11px] ${failed ? "border-[#fecaca] bg-[#fef2f2] text-[#b91c1c]" : "border-[#c3dfcb] bg-white text-[#1b4332]"}`}
            >
              {message}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
