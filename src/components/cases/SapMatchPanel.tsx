"use client";

import { useCallback, useEffect, useState } from "react";
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
} from "@/lib/sap-match-progress";
import type {
  LineResult,
  MatchCheck,
  MatchStatus,
} from "@/lib/sap-match/types";
import { CheckBlock } from "./sap-match/CheckBlock";
import { FinalPostSection } from "./sap-match/FinalPostSection";
import { PostedInvoice } from "./sap-match/PostedInvoice";
import { sapMatchPresentation, sapMessage } from "@/lib/sap-match/terminology";
import { inr } from "./sap-match/format";
import { MatchLineCard } from "./sap-match/MatchLineCard";
import { AppliedMatchingRules } from "./sap-match/AppliedMatchingRules";
import { VendorLinker } from "./sap-match/VendorLinker";
import { WhatGoesToSap } from "./sap-match/WhatGoesToSap";

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
    label: "Returned",
    pill: "bg-[#f0ede8] text-[#5c5650]",
    banner: "border-[#dcd5cb] bg-[#f6f3ee]",
    Icon: Send,
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
}: {
  caseId: string;
  variant?: "full" | "sidebar";
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
  } | null>(null);
  const [showPassed, setShowPassed] = useState(false);

  const load = useCallback(
    async (quiet = false, refresh = false) => {
      if (!quiet) setLoading(true);
      setLoadError(null);
      try {
        const response = await fetchSapMatch(caseId, refresh);
        setData(response);
        return response;
      } catch (error) {
        setLoadError(
          error instanceof Error
            ? error.message
            : "Could not load the SAP match.",
        );
        return null;
      } finally {
        setLoading(false);
      }
    },
    [caseId],
  );

  useEffect(() => {
    setConfirmingDraft(false);
    setDraftMessage(null);
    setActionError(null);
    void load();
  }, [load]);

  const polling = needsSapMatchPolling(data) && !loadError;
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
    setBusy(true);
    setActionError(null);
    const result = await postSapMatchAction(caseId, action);
    if (!result.ok) setActionError(result.error);
    await load(true);
    setBusy(false);
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

  async function createDraft() {
    setCreating(true);
    setDraftMessage(null);
    const result = await createMatchedSapDraft(caseId);
    setDraftMessage({ text: result.message, failed: !result.ok });
    setCreating(false);
    setConfirmingDraft(false);
    await load(true);
  }

  async function recheck() {
    setBusy(true);
    setActionError(null);
    await load(true, true);
    setBusy(false);
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-4 py-6 text-xs text-[#8a7f72]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Matching with SAP…
      </div>
    );
  }

  if (loadError || !data) {
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

  if (
    data.matchJob?.status === "queued" ||
    data.matchJob?.status === "running"
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

  const ap = data.postings.find(
    (posting) =>
      posting.kind === "AP" &&
      posting.sap_env === "test" &&
      posting.sap_docnum &&
      (posting.status === "prepared" || posting.status === "posted"),
  );

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
            caseId={caseId}
            status={ap.status as "prepared" | "posted"}
            documentNumber={ap.sap_docnum!}
            onChanged={() => void load(true)}
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
    <Matched
      caseId={caseId}
      variant={variant}
      data={data}
      ap={ap}
      busy={busy}
      actionError={actionError}
      confirmingDraft={confirmingDraft}
      creating={creating}
      draftMessage={draftMessage}
      showPassed={showPassed}
      onTogglePassed={() => setShowPassed((current) => !current)}
      onConfirmDraft={(value) => setConfirmingDraft(value)}
      onCreateDraft={() => void createDraft()}
      onRefresh={() => void recheck()}
      onChoose={choose}
      onUndo={(check) => void act({ action: "undo", checkId: check.id })}
      onAllocate={(lineIndex, allocations) =>
        void act({ action: "allocate", lineIndex, allocations })
      }
      onResetAllocation={(lineIndex) =>
        void act({ action: "reset-allocation", lineIndex })
      }
      onLinkVendor={(cardCode) => void act({ action: "map-vendor", cardCode })}
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
  );
}

function Matched({
  caseId,
  variant,
  data,
  ap,
  busy,
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
  actionError: string | null;
  confirmingDraft: boolean;
  creating: boolean;
  draftMessage: { text: string; failed: boolean } | null;
  showPassed: boolean;
  onTogglePassed: () => void;
  onConfirmDraft: (value: boolean) => void;
  onCreateDraft: () => void;
  onRefresh: () => void;
  onChoose: (check: MatchCheck, choice: string, reason: string) => void;
  onUndo: (check: MatchCheck) => void;
  onAllocate: (lineIndex: number, allocations: Record<string, number>) => void;
  onResetAllocation: (lineIndex: number) => void;
  onLink: (line: LineResult, itemCode: string) => void;
  onLinkVendor: (cardCode: string) => void;
}) {
  const { invoice } = data;
  const result = sapMatchPresentation(data.result, [
    invoice.vendorName ?? "",
    data.vendor?.cardName ?? "",
    ...invoice.lines.map((line) => line.description ?? ""),
  ]);
  const locked = Boolean(ap);
  const meta = STATUS[locked ? "ready" : result.status];
  const openCount = result.open.length;

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
                  : "A/P Invoice Draft"
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
              : `Draft Entry No. ${ap.sap_docnum} saved, not posted`
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
    (check) => !check.open && !check.decision,
  );
  const canCreate =
    data.postable &&
    result.status === "ready" &&
    !ap &&
    Boolean(result.payload);
  const vendorLabel = data.vendor
    ? `${data.vendor.cardName} (${data.vendor.cardCode})`
    : (invoice.vendorName ?? "vendor");
  const first = result.open[0];

  return (
    <div className="space-y-4 px-4 py-3">
      {/* Verdict */}
      <section
        className={`flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 ${ap ? "border-[#c4dfcf] bg-[#f1f8f4]" : meta.banner}`}
      >
        <meta.Icon className="h-5 w-5 shrink-0 text-[#3d3530]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[13px] font-semibold text-[#111827]">
              {ap
                ? ap.status === "posted"
                  ? `Posted as A/P Invoice ${ap.sap_docnum}`
                  : `Draft Entry No. ${ap.sap_docnum} is saved in SAP`
                : result.status === "ready"
                  ? "Everything matches"
                  : (first?.title ?? result.summary)}
            </div>
            <StatusPill
              status={locked ? "ready" : result.status}
              label={
                ap
                  ? ap.status === "posted"
                    ? "Posted"
                    : "A/P Invoice Draft"
                  : undefined
              }
            />
          </div>
          <div className="mt-0.5 text-[11px] leading-4 text-[#6b5d50]">
            {vendorLabel} · Vendor Ref. No. {invoice.invoiceNumber}
            {result.payload
              ? ` · ${inr(result.payload.bookedTaxable)} before tax`
              : ""}
            {!ap && result.status !== "ready" && openCount > 1
              ? ` · ${openCount - 1} more thing${openCount > 2 ? "s" : ""} below`
              : ""}
          </div>
        </div>
        <span className="rounded-full bg-[#fff7ed] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#b45309] ring-1 ring-inset ring-[#fcd9b6]">
          SAP {data.sapEnv === "test" ? "Test" : data.sapEnv}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-[11px]"
          disabled={busy}
          onClick={onRefresh}
        >
          <RefreshCw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} />{" "}
          Re-check
        </Button>
      </section>

      {actionError ? (
        <div className="rounded-lg border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-[11px] text-[#b91c1c]">
          {sapMessage(actionError)}
        </div>
      ) : null}

      {generalOpen.map((check) =>
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
        result={result}
        lines={result.lines}
        vendorLabel={vendorLabel}
      />

      {/* Draft and final posting */}
      {ap ? (
        <FinalPostSection
          caseId={caseId}
          status={ap.status as "prepared" | "posted"}
          documentNumber={ap.sap_docnum!}
          onChanged={onRefresh}
        />
      ) : (
        <div className="space-y-2">
          {draftMessage ? (
            <div
              className={`rounded-lg border px-3 py-2 text-[11px] ${draftMessage.failed ? "border-[#fecaca] bg-[#fef2f2] text-[#b91c1c]" : "border-[#c3dfcb] bg-[#ebf5ee] text-[#1b4332]"}`}
            >
              {sapMessage(draftMessage.text)}
            </div>
          ) : null}
          {!data.postable ? (
            <p className="text-[11px] text-[#8a7f72]">
              Approve this case before creating an A/P Invoice Draft.
            </p>
          ) : result.status === "ready" ? (
            confirmingDraft ? (
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span>
                  Create an A/P Invoice Draft in SAP Test? No invoice will be
                  posted.
                </span>
                <Button size="sm" disabled={creating} onClick={onCreateDraft}>
                  {creating ? (
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  ) : (
                    <Send className="mr-1.5 h-3 w-3" />
                  )}
                  Confirm draft
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={creating}
                  onClick={() => onConfirmDraft(false)}
                >
                  Cancel
                </Button>
              </div>
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
      )}

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

      <AppliedMatchingRules rules={data.rules} />
    </div>
  );
}
