"use client";

import { useState } from "react";
import { Check, Loader2, X } from "lucide-react";

import { CaseConfirmDialog } from "@/components/cases/CaseConfirmDialog";
import { Button } from "@/components/ui/button";
import { updateCaseDecision } from "@/lib/case-persistence";

type Decision = "accepted" | "rejected";

/**
 * Approve or reject the case from the SAP step, so the reviewer does not have
 * to leave the page. The server still enforces every approval rule.
 */
export function CaseDecisionActions({
  caseId,
  blockedReason,
  disabled = false,
  onDecided,
}: {
  caseId: string;
  /** Why approval is not possible yet, when the page already knows. */
  blockedReason?: string | null;
  disabled?: boolean;
  onDecided: () => void | Promise<void>;
}) {
  const [confirming, setConfirming] = useState<Decision | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: Decision) {
    if (saving || disabled || (decision === "accepted" && blockedReason))
      return;
    setSaving(true);
    setError(null);
    try {
      await updateCaseDecision(caseId, decision);
      setConfirming(null);
      await onDecided();
    } catch (failure) {
      setConfirming(null);
      setError(
        failure instanceof Error
          ? failure.message
          : `Could not ${decision === "accepted" ? "approve" : "reject"} the case.`,
      );
    } finally {
      setSaving(false);
    }
  }

  const approveBlocked = Boolean(blockedReason);
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-[#6b5d50]">
        Approve this case to create the A/P Invoice Draft.
        {blockedReason ? (
          <b className="ml-1 font-semibold text-[#8a5207]">{blockedReason}</b>
        ) : null}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          className="h-8 rounded-lg bg-[#2d6a4f] px-3 text-[11px] font-medium text-white hover:bg-[#245a42]"
          disabled={disabled || saving || approveBlocked}
          onClick={() => setConfirming("accepted")}
        >
          {saving && confirming === "accepted" ? (
            <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
          ) : (
            <Check className="mr-1.5 h-3 w-3" strokeWidth={3} />
          )}
          Approve
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 rounded-lg border-[#e5c3bd] px-3 text-[11px] font-medium text-[#b3261e] hover:bg-[#fdf6f5]"
          disabled={disabled || saving}
          onClick={() => setConfirming("rejected")}
        >
          <X className="mr-1.5 h-3 w-3" strokeWidth={3} />
          Reject
        </Button>
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-[#f3c6c0] bg-[#fdf6f5] px-3 py-2 text-[11px] text-[#b3261e]"
        >
          {error}
        </p>
      ) : null}
      <CaseConfirmDialog
        open={confirming !== null}
        title={
          confirming === "rejected" ? "Reject this case?" : "Approve this case?"
        }
        description={
          confirming === "rejected"
            ? "Rejected cases are final and no A/P Invoice Draft can be created from them."
            : "Approved cases are final. You can then create the A/P Invoice Draft in SAP."
        }
        confirmLabel={
          confirming === "rejected" ? "Reject case" : "Approve case"
        }
        variant={confirming === "rejected" ? "danger" : "default"}
        loading={saving}
        onOpenChange={(open) => {
          if (!open && !saving) setConfirming(null);
        }}
        onConfirm={() => confirming && void decide(confirming)}
      />
    </div>
  );
}
