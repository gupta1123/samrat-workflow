import { CheckCircle2 } from "lucide-react";

/** Saved drafts are terminal. Posted status is retained only for historical records. */
export function FinalPostSection({
  status,
  documentNumber,
}: {
  status: "prepared" | "posted";
  documentNumber: string;
}) {
  const savedDraft = status === "prepared";
  return (
    <div
      className="rounded-xl border border-[#c3dfcb] bg-[#ebf5ee] px-4 py-2.5 text-[11px] text-[#1b4332]"
      role="status"
    >
      <div className="flex items-start gap-2.5">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div className="text-[12px] font-semibold">
            {savedDraft
              ? "Completed - A/P Invoice Draft saved in SAP Test"
              : "A/P Invoice previously posted in SAP"}
          </div>
          <div className="mt-0.5 text-[11px] leading-4">
            {savedDraft
              ? `Draft Entry No. ${documentNumber} is saved in SAP Test. This is the final step in this app. No A/P Invoice has been posted.`
              : `A/P Invoice ${documentNumber} was already posted. This historical record is read-only.`}
          </div>
          {savedDraft ? (
            <div className="mt-1 text-[11px] font-medium">
              No further posting action is required.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
