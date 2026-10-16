"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  Send,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  createMatchedSapDraft,
  fetchSapMatch,
  postSapMatchAction,
  type SapMatchAction,
  type SapMatchAvailable,
  type SapMatchResponse,
} from "@/lib/sap-match-client";
import { itemMappingKey } from "@/lib/sap-match/engine";
import {
  findPostedApInvoice,
  needsSapMatchPolling,
  pollSapMatch,
  retainSapMatchDuringUpdate,
} from "@/lib/sap-match-progress";
import type {
  LineResult,
  MatchCheck,
  MatchStatus,
} from "@/lib/sap-match/types";
import { DEFAULT_MATCH_RULES, EMPTY_MATCH_STATE } from "@/lib/sap-match/types";
import { matchTimestamp, truthfulChecks } from "@/lib/sap-match/evidence";
import {
  ItemMatchingEvidence,
  SupplierEvidence,
} from "./sap-match/MatchingEvidence";
import { CheckBlock } from "./sap-match/CheckBlock";
import { FinalPostSection } from "./sap-match/FinalPostSection";
import { PostedInvoice } from "./sap-match/PostedInvoice";
import { sapMatchPresentation, sapMessage } from "@/lib/sap-match/terminology";
import { MatchLineCard } from "./sap-match/MatchLineCard";
import { VendorLinker } from "./sap-match/VendorLinker";
import { WhatGoesToSap } from "./sap-match/WhatGoesToSap";
import { DraftHeaderFields } from "./sap-match/DraftHeaderFields";
import {
  MatchUpdateContext,
  MatchUpdateNotice,
  type MatchUpdate,
} from "./sap-match/MatchUpdateContext";
import { SapUpdateToast } from "./sap-match/SapUpdateToast";
import { CaseDecisionActions } from "./sap-match/CaseDecisionActions";
import type { DraftFieldChoices } from "@/lib/sap-draft-fields";
import { SavedPostingCard } from "./sap-match/SavedPostingPreview";
import { ReviewHeader } from "./sap-match/ReviewHeader";
import { reviewModel } from "@/lib/sap-match/review-model";
import { isNonStockPoReview } from "@/lib/sap-match/non-stock-po-review";
import { RecordedInvoiceReview } from "./sap-match/RecordedInvoiceReview";

const STATUS: Record<
  MatchStatus,
  { label: string; pill: string; banner: string; Icon: typeof Check }
> = {
  ready: {
    label: "Ready",
    pill: "bg-[#e9f4ee] text-[#2c6a4f]",
    banner: "border-[#c4dfcf] bg-[#f1f8f4]",
    Icon: CheckCircle2,
  },
  review: {
    label: "Needs you",
    pill: "bg-[#fdf4e2] text-[#9a5a0a]",
    banner: "border-[#f0d7a6] bg-[#fdf7ea]",
    Icon: AlertTriangle,
  },
  blocked: {
    label: "Can't send yet",
    pill: "bg-[#fdeeec] text-[#b3261e]",
    banner: "border-[#f3c6c0] bg-[#fdf3f1]",
    Icon: XCircle,
  },
  waiting: {
    label: "Waiting",
    pill: "bg-[#f0ede8] text-[#5c5650]",
    banner: "border-[#dcd5cb] bg-[#f6f3ee]",
    Icon: Clock,
  },
  returned: {
    label: "Correction needed",
    pill: "bg-[#f0ede8] text-[#5c5650]",
    banner: "border-[#dcd5cb] bg-[#f6f3ee]",
    Icon: AlertTriangle,
  },
  closed: {
    label: "Closed",
    pill: "bg-[#f0ede8] text-[#5c5650]",
    banner: "border-[#dcd5cb] bg-[#f6f3ee]",
    Icon: XCircle,
  },
};

function StatusPill({
  status,
  label,
}: {
  status: MatchStatus;
  label?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS[status].pill}`}
    >
      {label ?? STATUS[status].label}
    </span>
  );
}

export function SapMatchPanel({
  caseId,
  variant = "full",
  approvalBlockedReason = null,
  onCaseDecided,
  onNonStockReviewChange,
}: {
  caseId: string;
  variant?: "full" | "sidebar";
  /** Shown beside Approve when the page already knows approval is not possible yet. */
  approvalBlockedReason?: string | null;
  /** Lets the page refresh its own copy of the case after Approve or Reject. */
  onCaseDecided?: () => void | Promise<void>;
  onNonStockReviewChange?: (nonStock: boolean) => void;
}) {
  const [data, setData] = useState<SapMatchResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingDraft, setConfirmingDraft] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draftMessage, setDraftMessage] = useState<{
    text: string;
    failed: boolean;
    numberingSeriesRequired?: boolean;
  } | null>(null);
  const [showPassed, setShowPassed] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<MatchUpdate | null>(null);
  const [validationRequired, setValidationRequired] = useState(false);
  const requestVersion = useRef(0);
  const actionInFlight = useRef(false);
  const activeCase = useRef(caseId);
  activeCase.current = caseId;

  const load = useCallback(
    async (quiet = false, refresh = false) => {
      const version = ++requestVersion.current;
      if (!quiet) setLoading(true);
      setLoadError(null);
      try {
        const response = await fetchSapMatch(caseId, refresh);
        if (activeCase.current !== caseId || version !== requestVersion.current)
          return null;
        setData((previous) => retainSapMatchDuringUpdate(previous, response));
        if (
          response.matchJob?.status === "failed" ||
          response.matchJob?.status === "cancelled"
        ) {
          setActionError(
            response.matchJob.error ??
              "The change could not be verified. Retry the check.",
          );
          setPendingUpdate((previous) =>
            previous ? { ...previous, phase: "failed" } : previous,
          );
          setValidationRequired(true);
        } else if (!needsSapMatchPolling(response)) {
          setPendingUpdate(null);
          setValidationRequired(false);
        }
        return response;
      } catch (error) {
        if (activeCase.current !== caseId || version !== requestVersion.current)
          return null;
        setLoadError(
          error instanceof Error
            ? error.message
            : "Could not load the SAP match.",
        );
        setPendingUpdate((previous) =>
          previous ? { ...previous, phase: "failed" } : previous,
        );
        setValidationRequired(true);
        return null;
      } finally {
        if (activeCase.current === caseId && version === requestVersion.current)
          setLoading(false);
      }
    },
    [caseId],
  );

  useEffect(() => {
    const requests = requestVersion;
    setData(null);
    setPendingUpdate(null);
    setValidationRequired(false);
    setBusy(false);
    setCreating(false);
    setConfirmingDraft(false);
    setDraftMessage(null);
    setActionError(null);
    void load();
    return () => {
      requests.current++;
    };
  }, [load]);

  const polling = needsSapMatchPolling(data) && !loadError;
  useEffect(() => {
    onNonStockReviewChange?.(
      Boolean(data?.available && isNonStockPoReview(data.invoice, data.result)),
    );
  }, [data, onNonStockReviewChange]);
  useEffect(() => {
    if (!polling) return;
    return pollSapMatch(
      () => load(true),
      (error) =>
        setLoadError(
          error instanceof Error
            ? error.message
            : "Could not load the SAP match.",
        ),
    );
  }, [polling, load]);

  async function act(action: SapMatchAction) {
    if (actionInFlight.current || (needsSapMatchPolling(data) && !loadError))
      return;
    actionInFlight.current = true;
    requestVersion.current++;
    setBusy(true);
    setActionError(null);
    setValidationRequired(true);
    const lineIndex =
      "lineIndex" in action
        ? action.lineIndex
        : "checkId" in action && data?.available
          ? (data.result.checks.find((check) => check.id === action.checkId)
              ?.lineIndex ?? null)
          : action.action === "map-item" && data?.available
            ? (data.invoice.lines.find(
                (line) => itemMappingKey(line) === action.mappingKey,
              )?.index ?? null)
            : null;
    setPendingUpdate({ action, lineIndex, phase: "saving" });
    try {
      const result = await postSapMatchAction(caseId, action);
      if (activeCase.current !== caseId) return;
      if (!result.ok)
        throw new Error(result.error ?? "Could not save this selection.");
      setPendingUpdate({ action, lineIndex, phase: "validating" });
      await load(true);
    } catch (error) {
      if (activeCase.current !== caseId) return;
      setActionError(
        error instanceof Error
          ? error.message
          : "Could not save this selection.",
      );
      setPendingUpdate({ action, lineIndex, phase: "failed" });
    } finally {
      actionInFlight.current = false;
      if (activeCase.current === caseId) setBusy(false);
    }
  }

  function choose(check: MatchCheck, choice: string, reason: string) {
    if (choice === "reset" && check.lineIndex !== null) {
      void act({ action: "reset-allocation", lineIndex: check.lineIndex });
      return;
    }
    void act({
      action: "decide",
      checkId: check.id,
      choice,
      ...(reason ? { reason } : {}),
    });
  }

  async function createDraft(choices: DraftFieldChoices) {
    if (busy || creating || validationRequired || needsSapMatchPolling(data))
      return;
    setCreating(true);
    setDraftMessage(null);
    try {
      const result = await createMatchedSapDraft(caseId, choices);
      if (activeCase.current !== caseId) return;
      setDraftMessage({
        text: result.message,
        failed: !result.ok,
        numberingSeriesRequired: result.numberingSeriesRequired,
      });
      setConfirmingDraft(!result.ok);
      await load(true);
    } catch (error) {
      if (activeCase.current !== caseId) return;
      setDraftMessage({
        text:
          error instanceof Error
            ? error.message
            : "Could not confirm whether the draft was saved. Retry the SAP check before trying again.",
        failed: true,
      });
      setConfirmingDraft(true);
      await load(true);
    } finally {
      if (activeCase.current === caseId) setCreating(false);
    }
  }

  async function recheck() {
    if (actionInFlight.current || busy) return;
    setBusy(true);
    setValidationRequired(true);
    setPendingUpdate({ action: null, lineIndex: null, phase: "validating" });
    setActionError(null);
    await load(true, true);
    if (activeCase.current === caseId) setBusy(false);
  }

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-xs text-[#8a7f72]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Matching with SAP…
      </div>
    );
  }

  if (!data) {
    return (
      <div className="px-4 py-4">
        <div className="rounded-lg border border-[#fecaca] bg-[#fef2f2] px-4 py-3 text-[11px] text-[#b91c1c]">
          {loadError ?? "SAP is unavailable."}
          <Button
            size="sm"
            variant="outline"
            className="ml-3 h-7 px-2.5 text-[11px]"
            onClick={() => void load()}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const posted = findPostedApInvoice(data.postings, data.sapEnv);
  if (posted) {
    if (variant === "sidebar") {
      return (
        <div className="space-y-1 px-4 py-3">
          <StatusPill status="ready" label="Posted" />
          <div className="text-[11px] text-[#3d3530]">
            Posted as A/P Invoice {posted.sap_docnum}
          </div>
        </div>
      );
    }
    return (
      <PostedInvoice
        caseId={caseId}
        documentNumber={posted.sap_docnum}
        environment={data.sapEnv}
        details={data.postedDetails}
      />
    );
  }

  const ap = data.postings.find(
    (posting) =>
      posting.kind === "AP" &&
      posting.sap_env === data.sapEnv &&
      posting.sap_docnum &&
      (posting.status === "prepared" || posting.status === "posted"),
  );
  if (ap && data.draftDetails) {
    const saved = data.draftDetails.match;
    if (!saved) {
      return variant === "sidebar" ? (
        <div className="px-4 py-3 text-[11px]">
          Completed - Draft Entry No. {ap.sap_docnum} saved in SAP
        </div>
      ) : (
        <div className="space-y-3 px-4 py-3">
          <p className="text-[12px] font-semibold text-[#111827]">
            A/P Invoice Draft {ap.sap_docnum} saved in SAP {data.sapEnv}
          </p>
          <p className="text-[11px] leading-4 text-[#6b5d50]">
            The matching evidence was not saved when this draft was created. A
            current GRPO search cannot explain its historical match. Review the
            draft in SAP.
          </p>
          {data.draftDetails.bases.length ? (
            <p className="text-[11px] text-[#3d3530]">
              Saved base documents:{" "}
              {data.draftDetails.bases
                .map((base) => `${base.kind} ${base.number}`)
                .join(", ")}
            </p>
          ) : null}
          <SavedPostingCard caseId={caseId} details={data.draftDetails} />
          <FinalPostSection status="prepared" documentNumber={ap.sap_docnum!} />
        </div>
      );
    }
    return (
      <Matched
        caseId={caseId}
        variant={variant}
        data={{
          ...data,
          ...saved,
          available: true,
          rules: DEFAULT_MATCH_RULES,
          state: EMPTY_MATCH_STATE,
        }}
        ap={ap}
        busy={busy}
        actionError={actionError}
        confirmingDraft={false}
        creating={false}
        draftMessage={null}
        showPassed={showPassed}
        onTogglePassed={() => setShowPassed((current) => !current)}
        onConfirmDraft={() => {}}
        onCreateDraft={() => {}}
        onRefresh={() => void load(true)}
        onChoose={() => {}}
        onUndo={() => {}}
        onAllocate={() => {}}
        onResetAllocation={() => {}}
        onLink={() => {}}
        onLinkVendor={() => {}}
      />
    );
  }

  if (
    !data.available &&
    (data.matchJob?.status === "queued" || data.matchJob?.status === "running")
  ) {
    const stage = data.matchJob.stage || "Matching with SAP";
    return (
      <div className="px-4 py-4">
        <div className="flex items-start gap-2.5 rounded-lg border border-[#d8d0c5] bg-[#fbfaf8] px-4 py-3">
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-[#8a5a2b]" />
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold text-[#3d3530]">
              {stage}
            </div>
            <div className="mt-0.5 text-[11px] leading-4 text-[#8a7f72]">
              This continues safely in the background. You can leave this tab
              and return later.
            </div>
            {data.matchJob.error ? (
              <div className="mt-1 text-[10px] text-[#9a5a0a]">
                Previous attempt: {data.matchJob.error}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (!data.available) {
    const message = data.reason ?? "No SAP match is available for this case.";
    if (variant === "sidebar") {
      return (
        <div className="px-4 py-4">
          <div className="text-[11px] font-medium text-[#3d3530]">
            No SAP match
          </div>
          <div className="mt-0.5 text-[11px] leading-4 text-[#8a7f72]">
            {message}
          </div>
        </div>
      );
    }
    return (
      <div className="space-y-3 px-4 py-6">
        {ap ? (
          <FinalPostSection
            status={ap.status as "prepared" | "posted"}
            documentNumber={ap.sap_docnum!}
          />
        ) : null}
        <div className="flex items-start gap-2.5 rounded-lg border border-[#e0d8cc] bg-[#fbfaf8] px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#b45309]" />
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold text-[#3d3530]">
              No SAP match
            </div>
            <div className="mt-0.5 text-[11px] text-[#8a7f72]">{message}</div>
            {data.sapError ? (
              <div className="mt-1 break-words text-[10px] text-[#b3261e]">
                {data.sapError}
              </div>
            ) : null}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-[11px]"
            onClick={() => void recheck()}
          >
            <RefreshCw className="h-3 w-3" /> Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <MatchUpdateContext.Provider value={pendingUpdate}>
      <Matched
        caseId={caseId}
        variant={variant}
        data={data}
        ap={ap}
        approvalBlockedReason={approvalBlockedReason}
        onCaseDecided={async () => {
          await load(true);
          await onCaseDecided?.();
        }}
        busy={busy || (needsSapMatchPolling(data) && !loadError)}
        validationRequired={
          validationRequired || needsSapMatchPolling(data) || Boolean(loadError)
        }
        actionError={actionError ?? loadError}
        onRetry={() =>
          pendingUpdate?.action
            ? void act(pendingUpdate.action)
            : void recheck()
        }
        confirmingDraft={confirmingDraft}
        creating={creating}
        draftMessage={draftMessage}
        showPassed={showPassed}
        onTogglePassed={() => setShowPassed((current) => !current)}
        onConfirmDraft={(value) => setConfirmingDraft(value)}
        onCreateDraft={(choices) => void createDraft(choices)}
        onRefresh={() => void recheck()}
        onChoose={choose}
        onUndo={(check) => void act({ action: "undo", checkId: check.id })}
        onAllocate={(lineIndex, allocations) =>
          void act({ action: "allocate", lineIndex, allocations })
        }
        onResetAllocation={(lineIndex) =>
          void act({ action: "reset-allocation", lineIndex })
        }
        onLinkVendor={(cardCode) =>
          void act({ action: "map-vendor", cardCode })
        }
        onLink={(line: LineResult, itemCode: string) => {
          const invoiceLine = data.invoice.lines[line.index];
          const key = invoiceLine ? itemMappingKey(invoiceLine) : null;
          if (!data.vendor || !key) return;
          void act({
            action: "map-item",
            vendorCardCode: data.vendor.cardCode,
            mappingKey: key,
            sapItemCode: itemCode,
          });
        }}
      />
      {variant === "sidebar" ? null : (
        <SapUpdateToast
          update={pendingUpdate}
          onRetry={() =>
            pendingUpdate?.action
              ? void act(pendingUpdate.action)
              : void recheck()
          }
        />
      )}
    </MatchUpdateContext.Provider>
  );
}

function Matched({
  caseId,
  variant,
  data,
  ap,
  busy,
  validationRequired = false,
  approvalBlockedReason = null,
  onCaseDecided,
  onRetry,
  actionError,
  confirmingDraft,
  creating,
  draftMessage,
  showPassed,
  onTogglePassed,
  onConfirmDraft,
  onCreateDraft,
  onRefresh,
  onChoose,
  onUndo,
  onAllocate,
  onResetAllocation,
  onLink,
  onLinkVendor,
}: {
  caseId: string;
  variant: "full" | "sidebar";
  data: SapMatchAvailable;
  ap: { status: string; sap_docnum: string | null } | undefined;
  busy: boolean;
  validationRequired?: boolean;
  approvalBlockedReason?: string | null;
  onCaseDecided?: () => void | Promise<void>;
  onRetry?: () => void;
  actionError: string | null;
  confirmingDraft: boolean;
  creating: boolean;
  draftMessage: {
    text: string;
    failed: boolean;
    numberingSeriesRequired?: boolean;
  } | null;
  showPassed: boolean;
  onTogglePassed: () => void;
  onConfirmDraft: (value: boolean) => void;
  onCreateDraft: (choices: DraftFieldChoices) => void;
  onRefresh: () => void;
  onChoose: (check: MatchCheck, choice: string, reason: string) => void;
  onUndo: (check: MatchCheck) => void;
  onAllocate: (lineIndex: number, allocations: Record<string, number>) => void;
  onResetAllocation: (lineIndex: number) => void;
  onLink: (line: LineResult, itemCode: string) => void;
  onLinkVendor: (cardCode: string) => void;
}) {
  const { invoice } = data;
  const result = sapMatchPresentation(
    { ...data.result, checks: truthfulChecks(data.result) },
    [
      invoice.vendorName ?? "",
      data.vendor?.cardName ?? "",
      ...invoice.lines.map((line) => line.description ?? ""),
    ],
  );
  const locked = Boolean(ap);
  const unchecked = result.checks.filter(
    (check) => check.sev === "unchecked" && check.lineIndex === null,
  );
  const rs = result.method !== "2-way" ? result.receiptSearch : null;
  const searchNote = rs
    ? `SAP searched ${
        rs.method === "identifier"
          ? rs.identifiers?.length
            ? `by ${rs.identifiers.map((identifier) => `${identifier.field} ${identifier.value}`).join("; ")}`
            : rs.field
              ? `by ${rs.field} ${rs.value}`
              : "by packet references"
          : `the open GRPOs of supplier ${data.vendor?.cardCode ?? ""}`
      } · ${rs.documentsRead} document${rs.documentsRead === 1 ? "" : "s"} returned${
        rs.documentsRead >= rs.limit
          ? ` (search limit ${rs.limit} reached)`
          : ""
      }`
    : null;
  const [receiptsLine, setReceiptsLine] = useState<number | null>(null);
  const review = reviewModel(result, { approved: data.postable, invoice });
  const nonStockPoReview = isNonStockPoReview(invoice, result);
  const openCount = result.open.length;

  if (!locked && result.existingInvoice?.kind === "invoice") {
    if (variant === "sidebar") {
      return (
        <div className="space-y-1 px-4 py-3">
          <StatusPill
            status={result.status === "closed" ? "closed" : "review"}
            label={
              result.status === "closed"
                ? "Closed as duplicate"
                : "Already recorded"
            }
          />
          <div className="text-[11px] leading-4 text-[#3d3530]">
            A/P Invoice {result.existingInvoice.docNum}
          </div>
        </div>
      );
    }
    return (
      <RecordedInvoiceReview
        invoice={invoice}
        vendor={data.vendor}
        result={result}
        env={data.sapEnv}
        busy={busy}
        error={actionError ? sapMessage(actionError) : null}
        onRefresh={onRefresh}
        onChoose={onChoose}
        onUndo={onUndo}
      />
    );
  }

  if (variant === "sidebar") {
    return (
      <div className="space-y-1 px-4 py-3">
        <div className="flex items-center gap-2">
          <StatusPill
            status={locked ? "ready" : result.status}
            label={
              ap
                ? ap.status === "posted"
                  ? "Posted"
                  : "Draft saved"
                : nonStockPoReview && review.tone === "todo"
                  ? "Confirm PO lines"
                  : undefined
            }
          />
          <span className="truncate text-[11px] text-[#8a7f72]">
            {invoice.invoiceNumber}
          </span>
        </div>
        <div className="text-[11px] leading-4 text-[#3d3530]">
          {ap
            ? ap.status === "posted"
              ? `Posted as A/P Invoice ${ap.sap_docnum}`
              : `Completed - Draft Entry No. ${ap.sap_docnum} saved in SAP`
            : nonStockPoReview && review.tone === "todo"
              ? review.title
              : result.summary}
        </div>
        {!ap && openCount > 1 ? (
          <div className="text-[10px] text-[#8a7f72]">
            {openCount - 1} more to resolve
          </div>
        ) : null}
      </div>
    );
  }

  const generalOpen = result.checks.filter(
    (check) =>
      check.lineIndex === null &&
      check.id !== "freight" &&
      check.id !== "total" &&
      (check.open || check.decision),
  );
  const invoiceLevel = result.checks.filter(
    (check) =>
      (check.id === "freight" || check.id === "total") &&
      (check.open || check.decision),
  );
  const passed = result.checks.filter(
    (check) => check.sev === "pass" && !check.open && !check.decision,
  );
  const canCreate =
    !validationRequired &&
    data.postable &&
    result.status === "ready" &&
    !ap &&
    Boolean(result.payload);
  const vendorLabel = data.vendor
    ? `${data.vendor.cardName} (${data.vendor.cardCode})`
    : (invoice.vendorName ?? "vendor");
  const draftActions = !ap ? (
    <div className="space-y-2">
      {draftMessage ? (
        <div
          className={`rounded-lg border px-3 py-2 text-[11px] ${draftMessage.failed ? "border-[#fecaca] bg-[#fef2f2] text-[#b91c1c]" : "border-[#c3dfcb] bg-[#ebf5ee] text-[#1b4332]"}`}
        >
          {sapMessage(draftMessage.text)}
        </div>
      ) : null}
      {!data.postable ? (
        data.caseStatus === "completed" ? (
          <CaseDecisionActions
            caseId={caseId}
            blockedReason={approvalBlockedReason}
            disabled={busy || creating}
            onDecided={onCaseDecided ?? (() => {})}
          />
        ) : data.caseStatus === "rejected" ? (
          <p className="text-[11px] text-[#8a7f72]">
            This case was rejected, so no A/P Invoice Draft can be created.
          </p>
        ) : (
          <p className="text-[11px] text-[#8a7f72]">
            Approve this case before creating an A/P Invoice Draft.{" "}
            <Link
              href={`/cases/${caseId}`}
              className="font-medium text-[#6b4a33] underline"
            >
              Go to approval
            </Link>
          </p>
        )
      ) : result.status === "ready" ? (
        confirmingDraft ? (
          <DraftHeaderFields
            caseId={caseId}
            confirming
            numberingSeriesRetry={draftMessage?.numberingSeriesRequired}
            busy={creating || busy || validationRequired}
            onConfirm={onCreateDraft}
            onCancel={() => onConfirmDraft(false)}
          />
        ) : (
          <Button
            size="sm"
            className="rounded-lg bg-[#2b1a10] text-[11px] font-medium text-white shadow-sm hover:bg-[#3b271a]"
            disabled={!canCreate || busy}
            onClick={() => onConfirmDraft(true)}
          >
            <Send className="mr-1.5 h-3 w-3" />
            Create A/P Invoice Draft in SAP Test
          </Button>
        )
      ) : (
        <p className="text-[11px] text-[#8a7f72]">
          The draft can be created once every item above is settled. It is
          checked against SAP again at that moment.
        </p>
      )}
    </div>
  ) : null;

  return (
    <div className="space-y-4 px-4 py-3">
      <MatchUpdateNotice lineIndex={null} />
      <ReviewHeader
        title={
          ap
            ? ap.status === "posted"
              ? `Posted as A/P Invoice ${ap.sap_docnum}`
              : "Draft saved in SAP"
            : review.title
        }
        tone={ap ? "ok" : review.tone}
        env={data.sapEnv}
        invoice={invoice}
        vendor={data.vendor}
        result={result}
        unchecked={unchecked}
        onOpenReceipts={(lineIndex) => setReceiptsLine(lineIndex)}
        extras={{
          supplier: (
            <SupplierEvidence
              invoice={invoice}
              vendor={data.vendor}
              result={result}
            />
          ),
          item: (
            <div className="space-y-2">
              {result.lines.map((line) => (
                <ItemMatchingEvidence
                  key={line.index}
                  invoice={invoice}
                  line={line}
                  bare
                />
              ))}
            </div>
          ),
        }}
        checkedAt={result.checkedAt ?? data.matchJob?.finishedAt}
        savedLabel={
          locked
            ? `Comparison saved ${matchTimestamp(data.draftDetails?.recordedAt)}`
            : null
        }
        busy={busy}
        onRefresh={onRefresh}
      />

      {locked ? (
        <p className="text-[11px] leading-4 text-[#6b5d50]">
          This is the comparison used to create the saved draft. Quantities and
          open balances are historical; current GRPO balances may have changed.
          SAP validates the draft again before posting.
        </p>
      ) : null}

      {actionError ? (
        <div className="rounded-lg border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-[11px] text-[#b91c1c]">
          {sapMessage(actionError)}
          {onRetry ? (
            <button
              type="button"
              className="ml-2 font-medium underline"
              disabled={busy}
              onClick={onRetry}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {generalOpen
        .filter((check) => !locked || check.decision)
        .map((check) =>
          check.id === "vendor" && check.sev === "block" ? (
            <VendorLinker
              key={check.id}
              caseId={caseId}
              check={check}
              busy={busy || locked}
              onLink={onLinkVendor}
            />
          ) : (
            <CheckBlock
              key={check.id}
              check={check}
              locked={locked}
              busy={busy}
              onChoose={(choice, reason) => onChoose(check, choice, reason)}
              onUndo={() => onUndo(check)}
            />
          ),
        )}

      {result.lines.map((line) => (
        <MatchLineCard
          key={line.index}
          caseId={caseId}
          invoice={invoice}
          line={line}
          checks={result.checks.filter(
            (check) => check.lineIndex === line.index,
          )}
          locked={locked}
          busy={busy}
          vendorFound={Boolean(data.vendor)}
          rateTolerancePct={data.rules.rateTolerancePct}
          lineCount={result.lines.length}
          searchNote={searchNote}
          receiptsOpen={receiptsLine === line.index}
          onReceiptsOpenChange={(open) =>
            setReceiptsLine(open ? line.index : null)
          }
          onChoose={onChoose}
          onUndo={onUndo}
          onAllocate={onAllocate}
          onResetAllocation={onResetAllocation}
          onLink={onLink}
        />
      ))}

      {invoiceLevel.map((check) => (
        <CheckBlock
          key={check.id}
          check={check}
          locked={locked}
          busy={busy}
          onChoose={(choice, reason) => onChoose(check, choice, reason)}
          onUndo={() => onUndo(check)}
        />
      ))}

      <WhatGoesToSap
        caseId={caseId}
        invoice={invoice}
        result={result}
        lines={result.lines}
        vendorLabel={vendorLabel}
        saved={locked}
        savedDetails={data.draftDetails}
        actions={draftActions}
      />

      {ap ? (
        <FinalPostSection
          status={ap.status as "prepared" | "posted"}
          documentNumber={ap.sap_docnum!}
        />
      ) : !result.payload ? (
        draftActions
      ) : null}

      {passed.length ? (
        <div>
          <button
            type="button"
            className="text-[11px] font-medium text-[#6b4a33] underline"
            onClick={onTogglePassed}
          >
            {showPassed ? "Hide" : "Show"} {passed.length} checks that passed
          </button>
          {showPassed ? (
            <ul className="mt-2 space-y-1">
              {passed.map((check) => (
                <li
                  key={check.id}
                  className="flex items-center gap-2 text-[11px] text-[#3d3530]"
                >
                  <Check className="h-3.5 w-3.5 shrink-0 text-[#2c6a4f]" />
                  {check.title}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
