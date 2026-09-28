"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  FileSearch,
  FileUp,
  Loader2,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import { AppShell } from "@/components/dashboard/AppShell";
import { DocumentPicker } from "@/components/workspace/DocumentPicker";
import { CaseMismatchSkeleton } from "@/components/cases/CaseMismatchSkeleton";
import { MismatchComparePane } from "@/components/cases/MismatchComparePane";
import {
  getMismatchEvidenceFocus,
  MismatchSourceDrawer,
} from "@/components/cases/MismatchSourceDrawer";
import {
  TERMS_COMPLIANCE_FIELD,
  buildMismatchEvidence,
  formatMismatchValue,
  getEvidenceDocumentRole,
  getFieldLabel,
  getIssueDisplayTitle,
  getIssueListDetail,
  isCorrectionSensitiveMismatch,
  isSingleDocumentIssue,
  type MismatchEvidence,
  type MismatchRecord,
} from "@/components/cases/CaseMismatchPage";
import styles from "@/components/cases/CaseMismatchPage.module.css";
import { getAnalysisIntegrityApprovalBlockReason } from "@/lib/analysis-integrity";
import { getCaseDisplayStatus } from "@/lib/case-status";
import { getPersistedCaseIssues } from "@/lib/case-issues";
import { DOCUMENT_READABILITY_FIELD } from "@/lib/document-readability";
import { EXTRACTION_VERIFICATION_FIELD } from "@/lib/extraction-verification";
import {
  getSavedCaseInvoiceApprovalBlockReason,
  INVOICE_NUMBER_REQUIRED_FIELD,
} from "@/lib/invoice-approval";
import { isLineItemMismatchField } from "@/lib/line-items";
import { DUPLICATE_INVOICE_FIELD } from "@/lib/duplicate-invoice";
import { MISSING_DOCUMENTS_FIELD } from "@/lib/missing-documents";
import { WEIGHT_CALCULATION_FIELD } from "@/lib/weight-calculation";
import {
  createDraftCase,
  fetchCaseDetail,
  fetchCaseDetailPreferCache,
  removeAnalyzedCaseFile,
  updateCaseDecision,
  updateCaseMismatchDecision,
  validateAndAppendMissingCaseFiles,
  verifyAndReplaceUnreadableCasePage,
  type DocumentPageReplacementResponse,
  type MismatchDecision,
  type MissingDocumentUploadResponse,
  type SavedCaseDetail,
} from "@/lib/case-persistence";
import { normalizeUploadFiles } from "@/lib/client-image-upload";
import { getQueuedUploadFiles } from "@/lib/upload-groups";
import { planUploadQueue } from "@/lib/upload-queue";
import type { QueuedUpload } from "@/types/pipeline";

type LoadState = "loading" | "ready" | "error";
type ReviewScreen = "list" | "detail";
const VERIFIED_CHECK_PREFIX = "verified-check:";

function isVerifiedCheck(mismatch: MismatchRecord) {
  return mismatch.id.startsWith(VERIFIED_CHECK_PREFIX);
}

function getReviewQuestion(
  mismatch: MismatchRecord,
  evidence: MismatchEvidence[],
) {
  if (mismatch.fieldName === INVOICE_NUMBER_REQUIRED_FIELD) {
    return "Does the buyer-facing invoice show its invoice number?";
  }
  if (mismatch.fieldName === MISSING_DOCUMENTS_FIELD) {
    return "Have all required documents been added to this case?";
  }
  if (mismatch.fieldName === DUPLICATE_INVOICE_FIELD) {
    return "Will this invoice be booked only once?";
  }
  if (mismatch.fieldName === DOCUMENT_READABILITY_FIELD) {
    return "Can this source page be trusted for approval?";
  }
  if (mismatch.fieldName === EXTRACTION_VERIFICATION_FIELD) {
    return "Could the extracted value be verified from the source page?";
  }
  if (mismatch.fieldName === WEIGHT_CALCULATION_FIELD) {
    return "Does Gross Weight − Tare Weight equal Net Weight?";
  }
  if (isVerifiedCheck(mismatch)) {
    return `${getFieldLabel(mismatch.fieldName)} is consistent across the packet`;
  }
  const issueTitle = getIssueDisplayTitle(mismatch, evidence);
  if (
    /dispatched.*invoiced quantity|invoice.*dispatch.*quantity/i.test(
      issueTitle,
    )
  ) {
    return "Does the invoice quantity match the dispatched quantity?";
  }
  const label = getFieldLabel(mismatch.fieldName).toLowerCase();
  if (isSingleDocumentIssue(mismatch, evidence)) {
    return `Is the ${label} correct in this document?`;
  }
  return `Does the ${label} match across the packet?`;
}

function getDecisionSummary(
  mismatch: MismatchRecord,
  evidence: MismatchEvidence[],
) {
  if (mismatch.fieldName === MISSING_DOCUMENTS_FIELD) {
    return String(
      mismatch.values[0]?.value ?? "Required documents are missing.",
    );
  }
  if (mismatch.fieldName === DUPLICATE_INVOICE_FIELD) {
    return String(
      mismatch.values[0]?.value ?? "This invoice appears more than once.",
    );
  }
  if (
    mismatch.fieldName === DOCUMENT_READABILITY_FIELD ||
    mismatch.fieldName === INVOICE_NUMBER_REQUIRED_FIELD ||
    mismatch.fieldName === EXTRACTION_VERIFICATION_FIELD
  ) {
    return String(
      mismatch.values[0]?.value ??
        "The source evidence needs verification before approval.",
    );
  }
  const fieldLabel = getFieldLabel(mismatch.fieldName).toLowerCase();
  if (isVerifiedCheck(mismatch)) {
    return `The same ${fieldLabel} appears in ${evidence.length} source documents.`;
  }
  if (isSingleDocumentIssue(mismatch, evidence)) {
    return `The ${fieldLabel} in this document needs verification.`;
  }
  const comparedEvidence = evidence.slice(0, 2);
  if (comparedEvidence.length > 1) {
    const [left, right] = comparedEvidence;
    const leftRole = getEvidenceDocumentRole(left.document);
    const rightRole = getEvidenceDocumentRole(right.document);
    const leftValue = formatMismatchValue(
      mismatch.fieldName,
      left.value,
      leftRole,
    );
    const rightValue = formatMismatchValue(
      mismatch.fieldName,
      right.value,
      rightRole,
    );
    return `${leftRole} shows ${leftValue}, while ${rightRole} shows ${rightValue}.`;
  }
  return `The packet contains different ${fieldLabel} values.`;
}

function getEvidencePageLabel(
  mismatch: MismatchRecord,
  evidence: MismatchEvidence,
) {
  return `page ${getMismatchEvidenceFocus(mismatch, evidence).pageNumber}`;
}

function getRelatedFacts(
  mismatch: MismatchRecord,
  evidence: MismatchEvidence[],
) {
  const facts: Array<{ key: string; label: string; value: string }> = [];
  const seenKeys = new Set<string>();

  for (const entry of evidence) {
    for (const row of entry.contextRows) {
      if (
        row.emphasis ||
        row.key === mismatch.fieldName ||
        row.key === "issueDetail"
      )
        continue;
      if (seenKeys.has(row.key)) continue;
      const value = Array.isArray(row.value)
        ? row.value.join(", ")
        : typeof row.value === "object" && row.value !== null
          ? JSON.stringify(row.value)
          : String(row.value ?? "").trim();
      if (!value) continue;
      seenKeys.add(row.key);
      facts.push({ key: row.key, label: row.label, value });
      if (facts.length === 3) return facts;
    }
  }

  return facts;
}

function getIssueGroup(mismatch: MismatchRecord) {
  if (isVerifiedCheck(mismatch)) return "Verified packet data";
  if (mismatch.fieldName === DOCUMENT_READABILITY_FIELD)
    return "Document quality";
  if (mismatch.fieldName === MISSING_DOCUMENTS_FIELD)
    return "Required documents";
  if (isLineItemMismatchField(mismatch.fieldName)) return "Line items";
  if (mismatch.fieldName === TERMS_COMPLIANCE_FIELD)
    return "Terms & compliance";
  if (/amount|rate|tax|total|subtotal|currency/i.test(mismatch.fieldName)) {
    return "Commercial & amounts";
  }
  return "Packet details";
}

function parseNumericValue(value: unknown) {
  const match = String(value ?? "")
    .replace(/,/g, "")
    .match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function getMismatchAmount(mismatch: MismatchRecord) {
  if (!/amount|rate|tax|total|subtotal/i.test(mismatch.fieldName)) return 0;
  const values = mismatch.values
    .map((entry) => parseNumericValue(entry.value))
    .filter((value): value is number => value !== null);
  if (values.length >= 2)
    return Math.abs(Math.max(...values) - Math.min(...values));

  const differenceMatch = `${mismatch.analysis ?? ""} ${mismatch.fixPlan ?? ""}`
    .replace(/,/g, "")
    .match(/(?:difference|variance|short|excess)[^\d-]*(-?\d+(?:\.\d+)?)/i);
  const difference = Number(differenceMatch?.[1]);
  return Number.isFinite(difference) ? Math.abs(difference) : 0;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

function getResolutionLabel(
  mismatch: MismatchRecord,
  caseStatus?: SavedCaseDetail["case"]["status"],
) {
  if (isVerifiedCheck(mismatch)) return "Matched";
  if (mismatch.resolutionStatus === "accepted") return "Settled";
  if (mismatch.resolutionStatus === "rejected") return "In dispute";
  if (caseStatus === "accepted" || caseStatus === "rejected") return "Recorded";
  return "Needs decision";
}

export function CaseMismatchReviewPage({ caseId }: { caseId: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<SavedCaseDetail | null>(null);
  const [status, setStatus] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<ReviewScreen>("detail");
  const [activeMismatchId, setActiveMismatchId] = useState<string | null>(null);
  const [decisionStatus, setDecisionStatus] = useState<
    "idle" | "updating" | "error"
  >("idle");
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [missingUploadResult, setMissingUploadResult] =
    useState<MissingDocumentUploadResponse | null>(null);
  const [rejectedMissingUploads, setRejectedMissingUploads] = useState<
    QueuedUpload[]
  >([]);
  const [replacementCandidate, setReplacementCandidate] = useState<File | null>(
    null,
  );
  const [replacementResult, setReplacementResult] =
    useState<DocumentPageReplacementResponse | null>(null);
  const [sourcePreview, setSourcePreview] = useState<{
    mismatch: MismatchRecord;
    evidence: MismatchEvidence;
  } | null>(null);
  const [confirmingDeleteFileId, setConfirmingDeleteFileId] = useState<
    string | null
  >(null);
  const [deletingFile, setDeletingFile] = useState(false);
  const [deleteFileError, setDeleteFileError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchCaseDetailPreferCache(caseId)
      .then((payload) => {
        if (!active) return;
        setDetail(payload);
        setStatus("ready");
      })
      .catch((loadError) => {
        if (!active) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Failed to load mismatch review.",
        );
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [caseId]);

  const isCaseFinal =
    detail?.case.status === "accepted" || detail?.case.status === "rejected";
  const analysisIntegrityBlockReason = detail
    ? (getAnalysisIntegrityApprovalBlockReason(detail.case.processingMeta) ??
      getSavedCaseInvoiceApprovalBlockReason(detail))
    : "Case analysis has not loaded yet.";
  const visibleMismatches = useMemo(
    () => getPersistedCaseIssues(detail?.mismatches),
    [detail],
  );
  const pendingMismatches = useMemo(
    () =>
      visibleMismatches.filter(
        (mismatch) => mismatch.resolutionStatus === "pending",
      ),
    [visibleMismatches],
  );
  const settledMismatches = useMemo(
    () =>
      visibleMismatches.filter(
        (mismatch) => mismatch.resolutionStatus === "accepted",
      ),
    [visibleMismatches],
  );
  const disputedMismatches = useMemo(
    () =>
      visibleMismatches.filter(
        (mismatch) => mismatch.resolutionStatus === "rejected",
      ),
    [visibleMismatches],
  );

  const documentLookup = useMemo(() => {
    const map = new Map<string, SavedCaseDetail["documents"][number]>();
    detail?.documents.forEach((document) => {
      map.set(document.id, document);
      if (document.clientDocumentId)
        map.set(document.clientDocumentId, document);
    });
    return map;
  }, [detail]);

  useEffect(() => {
    setActiveMismatchId((current) =>
      current && visibleMismatches.some((mismatch) => mismatch.id === current)
        ? current
        : (pendingMismatches[0]?.id ?? visibleMismatches[0]?.id ?? null),
    );
  }, [pendingMismatches, visibleMismatches]);

  const activeMismatch = useMemo(
    () =>
      (activeMismatchId
        ? visibleMismatches.find((mismatch) => mismatch.id === activeMismatchId)
        : (pendingMismatches[0] ?? visibleMismatches[0])) ?? null,
    [activeMismatchId, pendingMismatches, visibleMismatches],
  );
  const activeEvidence = useMemo(
    () =>
      activeMismatch
        ? buildMismatchEvidence(activeMismatch, documentLookup)
        : [],
    [activeMismatch, documentLookup],
  );
  // Invoice uploads backing a duplicate warning. Deleting one removes the
  // duplicate and re-analyzes the remainder automatically.
  const duplicateInvoiceFiles = useMemo(() => {
    if (!detail || activeMismatch?.fieldName !== DUPLICATE_INVOICE_FIELD) {
      return [];
    }
    const invoiceSources = new Set(
      detail.documents
        .filter(
          (document) =>
            document.documentType === "Invoice" ||
            document.documentType === "Tax Invoice",
        )
        .map((document) => (document.sourceFileName ?? "").trim())
        .filter(Boolean),
    );
    return detail.files.filter((file) =>
      invoiceSources.has((file.originalName ?? "").trim()),
    );
  }, [detail, activeMismatch]);
  const replacementPreviewUrl = useMemo(
    () =>
      replacementCandidate ? URL.createObjectURL(replacementCandidate) : null,
    [replacementCandidate],
  );
  useEffect(
    () => () => {
      if (replacementPreviewUrl) URL.revokeObjectURL(replacementPreviewUrl);
    },
    [replacementPreviewUrl],
  );
  useEffect(() => {
    setReplacementCandidate(null);
    setReplacementResult(null);
  }, [activeMismatch?.id]);
  const groupedMismatches = useMemo(() => {
    const groups = new Map<string, MismatchRecord[]>();
    visibleMismatches.forEach((mismatch) => {
      const key = getIssueGroup(mismatch);
      groups.set(key, [...(groups.get(key) ?? []), mismatch]);
    });
    return Array.from(groups.entries());
  }, [visibleMismatches]);

  const amountAtRisk = useMemo(
    () =>
      visibleMismatches
        .filter((mismatch) => mismatch.resolutionStatus !== "accepted")
        .reduce((total, mismatch) => total + getMismatchAmount(mismatch), 0),
    [visibleMismatches],
  );

  const pendingMismatchCount = pendingMismatches.length;
  const documentReadingWarningCount = visibleMismatches.filter(
    (mismatch) => mismatch.fieldName === DOCUMENT_READABILITY_FIELD,
  ).length;
  const showsVerifiedChecks =
    visibleMismatches.length > 0 && visibleMismatches.every(isVerifiedCheck);
  const activeIndex = activeMismatch
    ? visibleMismatches.findIndex(
        (mismatch) => mismatch.id === activeMismatch.id,
      )
    : -1;

  useEffect(() => {
    if (screen !== "detail") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setScreen("list");
      if (event.key === "ArrowLeft" && activeIndex > 0) {
        setActiveMismatchId(visibleMismatches[activeIndex - 1]?.id ?? null);
      }
      if (
        event.key === "ArrowRight" &&
        activeIndex < visibleMismatches.length - 1
      ) {
        setActiveMismatchId(visibleMismatches[activeIndex + 1]?.id ?? null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeIndex, screen, visibleMismatches]);

  async function decideOne(
    mismatch: MismatchRecord,
    decision: MismatchDecision,
  ) {
    try {
      setDecisionStatus("updating");
      setDecisionError(null);
      await updateCaseMismatchDecision(caseId, mismatch.id, decision);
      const refreshed = await fetchCaseDetail(caseId);
      setDetail(refreshed);
      const refreshedVisible = getPersistedCaseIssues(refreshed.mismatches);
      const currentIndex = refreshedVisible.findIndex(
        (entry) => entry.id === mismatch.id,
      );
      const nextPending = [
        ...refreshedVisible.slice(currentIndex + 1),
        ...refreshedVisible.slice(0, currentIndex),
      ].find((entry) => entry.resolutionStatus === "pending");
      setActiveMismatchId(nextPending?.id ?? mismatch.id);
      setDecisionStatus("idle");
    } catch (decisionFailure) {
      setDecisionError(
        decisionFailure instanceof Error
          ? decisionFailure.message
          : `Failed to ${decision === "accepted" ? "settle" : "dispute"} mismatch.`,
      );
      setDecisionStatus("error");
    }
  }

  async function approveCase() {
    if (
      !detail ||
      analysisIntegrityBlockReason !== null ||
      documentReadingWarningCount > 0 ||
      pendingMismatchCount > 0 ||
      disputedMismatches.length > 0
    )
      return;
    try {
      setDecisionStatus("updating");
      setDecisionError(null);
      await updateCaseDecision(caseId, "accepted");
      setDetail(await fetchCaseDetail(caseId));
      setDecisionStatus("idle");
    } catch (decisionFailure) {
      setDecisionError(
        decisionFailure instanceof Error
          ? decisionFailure.message
          : "Failed to approve case.",
      );
      setDecisionStatus("error");
    }
  }

  async function addMissingDocuments(files: File[]) {
    if (!detail || files.length === 0 || decisionStatus === "updating") return;

    try {
      setDecisionStatus("updating");
      setDecisionError(null);
      setMissingUploadResult(null);
      setRejectedMissingUploads([]);
      const normalized = await normalizeUploadFiles(files);
      const currentFiles = detail.files.map((file) => ({
        id: file.id,
        name: file.originalName,
        source: "file" as const,
        stages: [],
      }));
      const plan = planUploadQueue(currentFiles, normalized, "prompt");
      if (plan.conflicts.length > 0) {
        throw new Error(
          "A file with this name is already in the case. Rename the new file and try again.",
        );
      }
      const result = await validateAndAppendMissingCaseFiles(
        caseId,
        plan.acceptedUploads,
      );
      const rejectedNames = new Set(result.rejectedFileNames);
      setRejectedMissingUploads(
        plan.acceptedUploads.filter((upload) =>
          getQueuedUploadFiles(upload).some((file) =>
            rejectedNames.has(file.name),
          ),
        ),
      );
      setMissingUploadResult(result);
      if (result.case) setDetail(await fetchCaseDetail(caseId));
      setDecisionStatus("idle");
      router.refresh();
    } catch (uploadError) {
      setDecisionError(
        uploadError instanceof Error
          ? uploadError.message
          : "Failed to add the missing documents.",
      );
      setDecisionStatus("error");
    }
  }

  async function selectReplacementPage(files: File[]) {
    setDecisionError(null);
    setReplacementResult(null);
    if (files.length !== 1) {
      setDecisionError("Choose exactly one image or one-page PDF.");
      return;
    }
    const [normalized] = await normalizeUploadFiles(files);
    if (!normalized) {
      setDecisionError("The selected replacement could not be read.");
      return;
    }
    setReplacementCandidate(normalized);
  }

  async function confirmPageReplacement() {
    if (
      !activeMismatch ||
      activeMismatch.fieldName !== DOCUMENT_READABILITY_FIELD ||
      !replacementCandidate ||
      decisionStatus === "updating"
    ) {
      return;
    }

    try {
      setDecisionStatus("updating");
      setDecisionError(null);
      setReplacementResult(null);
      const uploads = planUploadQueue(
        [],
        [replacementCandidate],
        "prompt",
      ).acceptedUploads;
      const result = await verifyAndReplaceUnreadableCasePage(
        caseId,
        activeMismatch.id,
        uploads,
      );
      setReplacementResult(result);
      if (result.decision === "accepted") {
        router.push(`/cases/${caseId}`);
        router.refresh();
        return;
      }
      setDecisionStatus("idle");
    } catch (replacementError) {
      setDecisionError(
        replacementError instanceof Error
          ? replacementError.message
          : "The page could not be verified, so the case was not changed.",
      );
      setDecisionStatus("error");
    }
  }

  async function createRejectedDocumentsAsCase() {
    if (!rejectedMissingUploads.length || decisionStatus === "updating") return;

    try {
      setDecisionStatus("updating");
      setDecisionError(null);
      const result = await createDraftCase({
        uploads: rejectedMissingUploads,
        allowDuplicate: true,
      });
      router.push(`/cases/${result.case.id}`);
      router.refresh();
    } catch (creationError) {
      setDecisionError(
        creationError instanceof Error
          ? creationError.message
          : "Could not create a separate case for these documents.",
      );
      setDecisionStatus("error");
    }
  }

  if (status === "loading") return <CaseMismatchSkeleton />;

  if (status === "error") {
    return (
      <AppShell>
        <div className={styles.redesignErrorState}>
          <div className={styles.redesignErrorCard}>
            <ShieldAlert />
            <div>
              <strong>Unable to load mismatch review</strong>
              <span>{error}</span>
            </div>
          </div>
        </div>
      </AppShell>
    );
  }

  if (!detail) return null;

  const statusLabel = getCaseDisplayStatus(detail.case.status).label;
  const statusTone =
    detail.case.status === "accepted"
      ? styles.redesignStatusSettled
      : detail.case.status === "rejected"
        ? styles.redesignStatusRejected
        : styles.redesignStatusReview;

  const activeIsVerifiedCheck = activeMismatch
    ? isVerifiedCheck(activeMismatch)
    : false;
  const activeIsMissingDocuments =
    activeMismatch?.fieldName === MISSING_DOCUMENTS_FIELD;
  const activeIsDocumentReadingWarning =
    activeMismatch?.fieldName === DOCUMENT_READABILITY_FIELD;
  const activeIsInvoiceNumberRequired =
    activeMismatch?.fieldName === INVOICE_NUMBER_REQUIRED_FIELD;
  const activeIsDuplicateInvoice =
    activeMismatch?.fieldName === DUPLICATE_INVOICE_FIELD;
  async function removeDuplicateFile(fileId: string) {
    if (deletingFile || decisionStatus === "updating") return;
    setDeletingFile(true);
    setDeleteFileError(null);
    try {
      await removeAnalyzedCaseFile(caseId, fileId);
      router.push(`/cases/${caseId}`);
    } catch (removeError) {
      setDeleteFileError(
        removeError instanceof Error
          ? removeError.message
          : "Could not remove this file.",
      );
    } finally {
      setDeletingFile(false);
      setConfirmingDeleteFileId(null);
    }
  }
  const activeBlocking = activeMismatch
    ? !activeIsVerifiedCheck && isCorrectionSensitiveMismatch(activeMismatch)
    : false;
  const relatedFacts = activeMismatch
    ? getRelatedFacts(activeMismatch, activeEvidence)
    : [];
  const activeAmount = activeMismatch ? getMismatchAmount(activeMismatch) : 0;
  const activeResolutionIsRecorded =
    Boolean(isCaseFinal) && activeMismatch?.resolutionStatus === "pending";

  return (
    <AppShell>
      <div className={styles.redesignPage}>
        {screen === "list" || !activeMismatch ? (
          <>
            <header className={styles.redesignHeader}>
              <div className={styles.redesignCrumb}>
                <Link href={`/cases/${caseId}`}>
                  All Cases / {detail.case.slug}
                </Link>
                <span>/</span>
                <strong>Mismatches</strong>
              </div>
              <div className={styles.redesignHeaderRow}>
                <h1>Mismatches</h1>
                <span className={`${styles.redesignStatus} ${statusTone}`}>
                  {statusLabel}
                </span>
                <div className={styles.redesignHeaderActions}>
                  <Link
                    href={`/cases/${caseId}`}
                    className={styles.redesignButtonOutline}
                  >
                    <ArrowLeft /> Back to case
                  </Link>
                  {!isCaseFinal ? (
                    <button
                      type="button"
                      className={styles.redesignButtonPrimary}
                      disabled={
                        documentReadingWarningCount > 0 ||
                        analysisIntegrityBlockReason !== null ||
                        pendingMismatchCount > 0 ||
                        disputedMismatches.length > 0 ||
                        decisionStatus === "updating"
                      }
                      title={
                        documentReadingWarningCount > 0
                          ? "Replace every affected page and analyze the case again before approval."
                          : analysisIntegrityBlockReason
                            ? analysisIntegrityBlockReason
                            : pendingMismatchCount > 0
                              ? "Settle every pending issue before approval."
                              : disputedMismatches.length > 0
                                ? "Resolve disputed issues before approval."
                                : undefined
                      }
                      onClick={() => void approveCase()}
                    >
                      {decisionStatus === "updating" ? (
                        <Loader2 className={styles.spinner} />
                      ) : (
                        <Check />
                      )}
                      Approve case
                    </button>
                  ) : null}
                </div>
              </div>
              <div className={styles.redesignHeaderMeta}>
                <span>{detail.case.displayName}</span>
                <i>·</i>
                <span>{detail.case.poNumber || "PO not detected"}</span>
                <i>·</i>
                <span>
                  {detail.case.invoiceNumber || "Invoice not detected"}
                </span>
              </div>
            </header>

            <section
              className={styles.mismatchMetrics}
              aria-label="Mismatch review status"
            >
              <div>
                <span>{showsVerifiedChecks ? "Checks" : "Open"}</span>
                <strong
                  className={
                    showsVerifiedChecks ? styles.metricGreen : styles.metricRed
                  }
                >
                  {showsVerifiedChecks
                    ? visibleMismatches.length
                    : pendingMismatchCount}
                </strong>
              </div>
              <div>
                <span>{showsVerifiedChecks ? "Matched" : "Settled"}</span>
                <strong className={styles.metricGreen}>
                  {settledMismatches.length}
                </strong>
              </div>
              <div>
                <span>In dispute</span>
                <strong className={styles.metricAmber}>
                  {disputedMismatches.length}
                </strong>
              </div>
              <div>
                <span>Amount at risk</span>
                <strong className={styles.metricRed}>
                  {amountAtRisk ? formatMoney(amountAtRisk) : "—"}
                </strong>
              </div>
              <div
                className={styles.mismatchProgress}
                aria-label={`${visibleMismatches.length - pendingMismatchCount} of ${visibleMismatches.length} reviewed`}
              >
                <span
                  className={styles.progressSettled}
                  style={{
                    width: `${visibleMismatches.length ? (settledMismatches.length / visibleMismatches.length) * 100 : 0}%`,
                  }}
                />
                <span
                  className={styles.progressDisputed}
                  style={{
                    width: `${visibleMismatches.length ? (disputedMismatches.length / visibleMismatches.length) * 100 : 0}%`,
                  }}
                />
                <span
                  className={styles.progressOpen}
                  style={{
                    width: `${visibleMismatches.length ? (pendingMismatchCount / visibleMismatches.length) * 100 : 0}%`,
                  }}
                />
              </div>
              <span className={styles.progressLabel}>
                {visibleMismatches.length - pendingMismatchCount} of{" "}
                {visibleMismatches.length} reviewed
              </span>
            </section>

            <main className={styles.mismatchList}>
              {visibleMismatches.length > 0 ? (
                groupedMismatches.map(([group, mismatches]) => (
                  <section className={styles.mismatchGroup} key={group}>
                    <div className={styles.mismatchGroupTitle}>
                      <span>{group}</span>
                      <i />
                    </div>
                    <div className={styles.mismatchGroupRows}>
                      {mismatches.map((mismatch) => {
                        const evidence = buildMismatchEvidence(
                          mismatch,
                          documentLookup,
                        );
                        const issueAmount = getMismatchAmount(mismatch);
                        return (
                          <button
                            type="button"
                            className={`${styles.mismatchRow} ${mismatch.resolutionStatus !== "pending" || isCaseFinal ? styles.mismatchRowReviewed : ""}`}
                            key={mismatch.id}
                            onClick={() => {
                              setActiveMismatchId(mismatch.id);
                              setScreen("detail");
                            }}
                          >
                            <span
                              className={`${styles.mismatchSeverity} ${isVerifiedCheck(mismatch) ? styles.mismatchSeverityMatched : isCorrectionSensitiveMismatch(mismatch) ? styles.mismatchSeverityHigh : styles.mismatchSeverityMedium}`}
                            />
                            <span className={styles.mismatchRowCopy}>
                              <strong>
                                {isVerifiedCheck(mismatch)
                                  ? `${getFieldLabel(mismatch.fieldName)} matched`
                                  : getIssueDisplayTitle(mismatch, evidence)}
                              </strong>
                              <span>
                                {isVerifiedCheck(mismatch)
                                  ? `${formatMismatchValue(mismatch.fieldName, mismatch.values[0]?.value, "")} · ${evidence.length} source documents`
                                  : getIssueListDetail(mismatch, evidence)}
                              </span>
                            </span>
                            <span
                              className={`${styles.mismatchAmount} ${issueAmount ? "" : styles.mismatchAmountEmpty}`}
                            >
                              {issueAmount ? formatMoney(issueAmount) : "—"}
                            </span>
                            <span
                              className={`${styles.mismatchResolution} ${styles[`mismatchResolution${mismatch.resolutionStatus === "pending" && isCaseFinal ? "recorded" : mismatch.resolutionStatus}`]}`}
                            >
                              {mismatch.resolutionStatus === "accepted" ? (
                                <CheckCircle2 />
                              ) : mismatch.resolutionStatus === "rejected" ? (
                                <TriangleAlert />
                              ) : isCaseFinal ? (
                                <FileSearch />
                              ) : (
                                <Circle />
                              )}
                              {getResolutionLabel(mismatch, detail.case.status)}
                            </span>
                            <ChevronRight className={styles.mismatchChevron} />
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ))
              ) : (
                <div className={styles.mismatchEmpty}>
                  <CheckCircle2 />
                  <h2>No mismatches found</h2>
                  <p>This packet did not contain any mismatched values.</p>
                </div>
              )}
            </main>
          </>
        ) : activeMismatch ? (
          <>
            <header
              className={`${styles.redesignHeader} ${styles.mismatchDetailHeader}`}
            >
              <div className={styles.redesignCrumb}>
                <Link href={`/cases/${caseId}`}>{detail.case.slug}</Link>
                <span>/</span>
                <button type="button" onClick={() => setScreen("list")}>
                  Mismatches
                </button>
              </div>
              <div className={styles.redesignHeaderRow}>
                <h1>
                  {activeIsVerifiedCheck
                    ? `${getFieldLabel(activeMismatch.fieldName)} matched`
                    : getIssueDisplayTitle(activeMismatch, activeEvidence)}
                </h1>
                <span className={`${styles.redesignStatus} ${statusTone}`}>
                  {statusLabel}
                </span>
                <div className={styles.redesignHeaderActions}>
                  <Link
                    href={`/cases/${caseId}`}
                    className={styles.redesignButtonOutline}
                  >
                    <ArrowLeft /> Back to case
                  </Link>
                  <div className={styles.mismatchNav}>
                    <button
                      type="button"
                      disabled={activeIndex <= 0}
                      onClick={() =>
                        setActiveMismatchId(
                          visibleMismatches[activeIndex - 1]?.id ?? null,
                        )
                      }
                      aria-label="Previous mismatch"
                    >
                      <ChevronLeft />
                    </button>
                    <span>
                      {activeIndex + 1} / {visibleMismatches.length}
                    </span>
                    <button
                      type="button"
                      disabled={activeIndex >= visibleMismatches.length - 1}
                      onClick={() =>
                        setActiveMismatchId(
                          visibleMismatches[activeIndex + 1]?.id ?? null,
                        )
                      }
                      aria-label="Next mismatch"
                    >
                      <ChevronRight />
                    </button>
                  </div>
                </div>
              </div>
            </header>

            <div className={styles.mismatchDetailBody}>
              <aside className={styles.mismatchDetailInfo}>
                <div className={styles.mismatchDetailEyebrow}>
                  {getIssueGroup(activeMismatch)} · {activeIndex + 1} of{" "}
                  {visibleMismatches.length}
                </div>
                <h2>{getReviewQuestion(activeMismatch, activeEvidence)}</h2>
                <div
                  className={`${styles.mismatchImpactTag} ${activeIsVerifiedCheck ? styles.mismatchImpactMatched : activeBlocking ? styles.mismatchImpactHigh : ""}`}
                >
                  {activeIsVerifiedCheck ? (
                    <CheckCircle2 />
                  ) : activeBlocking ? (
                    <TriangleAlert />
                  ) : (
                    <Circle />
                  )}
                  {activeIsVerifiedCheck
                    ? "Matched"
                    : activeIsMissingDocuments
                      ? "Incomplete"
                      : activeBlocking
                        ? "High impact"
                        : "Worth checking"}
                </div>
                <div
                  className={`${styles.mismatchExplanation} ${activeIsVerifiedCheck ? styles.mismatchExplanationMatched : ""}`}
                >
                  <span>
                    {activeIsVerifiedCheck
                      ? "What was checked"
                      : activeIsMissingDocuments
                        ? "What is missing"
                        : "What is different"}
                  </span>
                  <p className={styles.mismatchLede}>
                    {getDecisionSummary(activeMismatch, activeEvidence)}
                  </p>
                </div>

                {!activeIsMissingDocuments ? (
                  <div className={styles.mismatchSources}>
                    {activeEvidence.slice(0, 2).map((evidence) => (
                      <button
                        type="button"
                        className={styles.mismatchSourceCard}
                        key={evidence.key}
                        onClick={() =>
                          setSourcePreview({
                            mismatch: activeMismatch,
                            evidence,
                          })
                        }
                      >
                        <span className={styles.mismatchSourceBar} />
                        <span className={styles.mismatchSourceCopy}>
                          <strong>
                            {getEvidenceDocumentRole(evidence.document)}
                          </strong>
                          <span>
                            {getFieldLabel(activeMismatch.fieldName)} ·{" "}
                            {getEvidencePageLabel(activeMismatch, evidence)}
                          </span>
                        </span>
                        <span className={styles.mismatchSourceValue}>
                          {formatMismatchValue(
                            activeMismatch.fieldName,
                            evidence.value,
                            getEvidenceDocumentRole(evidence.document),
                          )}
                        </span>
                        <FileSearch />
                      </button>
                    ))}
                  </div>
                ) : null}

                {activeAmount > 0 ? (
                  <div className={styles.mismatchImpactAmount}>
                    <strong>{formatMoney(activeAmount)}</strong>
                    <span>difference found in this mismatch</span>
                  </div>
                ) : null}

                {relatedFacts.length > 0 ||
                activeMismatch.analysis ||
                activeMismatch.fixPlan ? (
                  <details className={styles.mismatchMore}>
                    <summary>
                      {activeIsVerifiedCheck
                        ? "More on this check"
                        : "More on this mismatch"}{" "}
                      <ChevronRight />
                    </summary>
                    <div>
                      {activeMismatch.analysis ? (
                        <p>{activeMismatch.analysis}</p>
                      ) : null}
                      {relatedFacts.length > 0 ? (
                        <dl>
                          {relatedFacts.map((fact) => (
                            <div key={fact.key}>
                              <dt>{fact.label}</dt>
                              <dd>{fact.value}</dd>
                            </div>
                          ))}
                        </dl>
                      ) : null}
                    </div>
                  </details>
                ) : null}

                {decisionError ? (
                  <div className={styles.mismatchDecisionError}>
                    {decisionError}
                  </div>
                ) : null}

                {missingUploadResult ? (
                  <div
                    className={`${styles.mismatchUploadResult} ${
                      missingUploadResult.acceptedFileNames.length > 0
                        ? styles.mismatchUploadResultAccepted
                        : styles.mismatchUploadResultRejected
                    }`}
                  >
                    <strong>
                      {missingUploadResult.acceptedFileNames.length > 0
                        ? `${missingUploadResult.acceptedFileNames.length} verified ${
                            missingUploadResult.acceptedFileNames.length === 1
                              ? "file"
                              : "files"
                          } added`
                        : "Document not added"}
                    </strong>
                    {missingUploadResult.files.map((file) => (
                      <span key={file.sourceFileName}>
                        {file.sourceFileName}: {file.reason}
                      </span>
                    ))}
                    <div className={styles.mismatchUploadResultActions}>
                      {missingUploadResult.acceptedFileNames.length > 0 ? (
                        <Link
                          href={`/cases/${caseId}`}
                          className={styles.redesignButtonPrimary}
                        >
                          Review case &amp; analyze
                        </Link>
                      ) : null}
                      {rejectedMissingUploads.length > 0 &&
                      missingUploadResult.files.some(
                        (file) => file.createNewCaseSuggested,
                      ) ? (
                        <button
                          type="button"
                          className={styles.redesignButtonOutline}
                          disabled={decisionStatus === "updating"}
                          onClick={() => void createRejectedDocumentsAsCase()}
                        >
                          Create separate case
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <div className={styles.mismatchDecisionArea}>
                  {activeMismatch.resolutionStatus === "pending" &&
                  !isCaseFinal ? (
                    activeIsDocumentReadingWarning ? (
                      <div className={styles.mismatchMissingAction}>
                        <strong>Approval is blocked for this page.</strong>
                        <span>
                          Choose a clear, upright copy of this exact page. It
                          will be AI-verified before the stored page changes.
                        </span>
                        <DocumentPicker
                          compact
                          actionLabel={
                            replacementCandidate
                              ? "Choose a different page"
                              : "Replace affected page"
                          }
                          maxFiles={1}
                          maxScanPages={1}
                          disabled={decisionStatus === "updating"}
                          onFiles={selectReplacementPage}
                        />
                        {replacementCandidate && replacementPreviewUrl ? (
                          <div className={styles.replacementCandidate}>
                            <div className={styles.replacementCandidateHeader}>
                              <span>
                                <FileUp /> Proposed replacement
                              </span>
                              <button
                                type="button"
                                aria-label="Remove proposed replacement"
                                disabled={decisionStatus === "updating"}
                                onClick={() => {
                                  setReplacementCandidate(null);
                                  setReplacementResult(null);
                                }}
                              >
                                <X />
                              </button>
                            </div>
                            {replacementCandidate.type === "application/pdf" ? (
                              <object
                                data={replacementPreviewUrl}
                                type="application/pdf"
                                aria-label="Proposed replacement PDF preview"
                              >
                                <span>{replacementCandidate.name}</span>
                              </object>
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={replacementPreviewUrl}
                                alt="Proposed replacement page preview"
                              />
                            )}
                            <small>{replacementCandidate.name}</small>
                            <button
                              type="button"
                              className={styles.redesignButtonPrimary}
                              disabled={decisionStatus === "updating"}
                              onClick={() => void confirmPageReplacement()}
                            >
                              {decisionStatus === "updating" ? (
                                <Loader2 className={styles.spinner} />
                              ) : (
                                <FileUp />
                              )}
                              {decisionStatus === "updating"
                                ? "Verifying page…"
                                : "Use this page & reanalyse"}
                            </button>
                          </div>
                        ) : null}
                        {replacementResult ? (
                          <div
                            className={`${styles.mismatchUploadResult} ${
                              replacementResult.decision === "accepted"
                                ? styles.mismatchUploadResultAccepted
                                : styles.mismatchUploadResultRejected
                            }`}
                          >
                            <strong>
                              {replacementResult.decision === "accepted"
                                ? "Replacement verified"
                                : "Replacement not used"}
                            </strong>
                            <span>{replacementResult.reason}</span>
                          </div>
                        ) : null}
                      </div>
                    ) : activeIsInvoiceNumberRequired ? (
                      <div className={styles.mismatchMissingAction}>
                        <strong>Invoice number is mandatory.</strong>
                        <span>
                          Upload a corrected packet with a numbered buyer-facing
                          invoice and analyze again. This requirement cannot be
                          marked as settled.
                        </span>
                        <Link
                          href="/workspace"
                          className={styles.redesignButtonPrimary}
                        >
                          <FileUp /> Upload corrected packet
                        </Link>
                      </div>
                    ) : activeIsMissingDocuments ? (
                      <div className={styles.mismatchMissingAction}>
                        <DocumentPicker
                          compact
                          disabled={decisionStatus === "updating"}
                          onFiles={addMissingDocuments}
                        />
                        <span>
                          {decisionStatus === "updating"
                            ? "Verifying document type and transaction before adding…"
                            : "Only verified documents for this transaction will be added."}
                        </span>
                      </div>
                    ) : activeIsDuplicateInvoice ? (
                      <>
                        <div className={styles.mismatchMissingAction}>
                          <strong>Remove the extra copy.</strong>
                          <span>
                            Deleting a duplicate upload removes this warning
                            and re-analyzes the remaining files automatically.
                          </span>
                          {duplicateInvoiceFiles.map((file) => (
                            <div
                              key={file.id}
                              className={styles.replacementCandidateHeader}
                            >
                              <span title={file.originalName}>
                                {file.originalName}
                              </span>
                              {confirmingDeleteFileId === file.id ? (
                                <>
                                  <button
                                    type="button"
                                    className={styles.redesignButtonPrimary}
                                    disabled={
                                      deletingFile ||
                                      decisionStatus === "updating"
                                    }
                                    onClick={() =>
                                      void removeDuplicateFile(file.id)
                                    }
                                  >
                                    {deletingFile ? (
                                      <Loader2
                                        className={styles.spinner}
                                      />
                                    ) : (
                                      <Trash2 />
                                    )}
                                    {deletingFile
                                      ? "Removing…"
                                      : "Confirm delete"}
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`Cancel deleting ${file.originalName}`}
                                    disabled={
                                      deletingFile ||
                                      decisionStatus === "updating"
                                    }
                                    onClick={() =>
                                      setConfirmingDeleteFileId(null)
                                    }
                                  >
                                    <X />
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  aria-label={`Delete ${file.originalName}`}
                                  disabled={
                                    deletingFile ||
                                    decisionStatus === "updating"
                                  }
                                  onClick={() =>
                                    setConfirmingDeleteFileId(file.id)
                                  }
                                >
                                  <Trash2 />
                                </button>
                              )}
                            </div>
                          ))}
                          {deleteFileError ? (
                            <div className={styles.mismatchDecisionError}>
                              {deleteFileError}
                            </div>
                          ) : null}
                        </div>
                        <div className={styles.mismatchDecisionButtons}>
                          <button
                            type="button"
                            className={styles.redesignButtonAmber}
                            disabled={
                              decisionStatus === "updating" || deletingFile
                            }
                            onClick={() =>
                              void decideOne(activeMismatch, "rejected")
                            }
                          >
                            Keep in dispute
                          </button>
                          <button
                            type="button"
                            className={styles.redesignButtonPrimary}
                            disabled={
                              decisionStatus === "updating" || deletingFile
                            }
                            onClick={() =>
                              void decideOne(activeMismatch, "accepted")
                            }
                          >
                            {decisionStatus === "updating" ? (
                              <Loader2 className={styles.spinner} />
                            ) : (
                              <Check />
                            )}
                            Mark as settled
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className={styles.mismatchDecisionButtons}>
                        <button
                          type="button"
                          className={styles.redesignButtonAmber}
                          disabled={decisionStatus === "updating"}
                          onClick={() =>
                            void decideOne(activeMismatch, "rejected")
                          }
                        >
                          Keep in dispute
                        </button>
                        <button
                          type="button"
                          className={styles.redesignButtonPrimary}
                          disabled={decisionStatus === "updating"}
                          onClick={() =>
                            void decideOne(activeMismatch, "accepted")
                          }
                        >
                          {decisionStatus === "updating" ? (
                            <Loader2 className={styles.spinner} />
                          ) : (
                            <Check />
                          )}
                          Mark as settled
                        </button>
                      </div>
                    )
                  ) : (
                    <div
                      className={`${styles.mismatchVerdict} ${activeResolutionIsRecorded ? styles.mismatchVerdictRecorded : activeMismatch.resolutionStatus === "accepted" ? styles.mismatchVerdictSettled : styles.mismatchVerdictDispute}`}
                    >
                      {activeResolutionIsRecorded ? (
                        <FileSearch />
                      ) : activeMismatch.resolutionStatus === "accepted" ? (
                        <CheckCircle2 />
                      ) : (
                        <TriangleAlert />
                      )}
                      <div>
                        <strong>
                          {getResolutionLabel(
                            activeMismatch,
                            detail.case.status,
                          )}
                        </strong>
                        <span>
                          {activeIsVerifiedCheck
                            ? "The compared value and its source evidence remain available for audit."
                            : "The original mismatch and source evidence remain on record."}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </aside>

              <MismatchComparePane
                caseId={caseId}
                detail={detail}
                mismatch={activeMismatch}
                evidence={activeEvidence}
                mode={activeIsVerifiedCheck ? "verified" : "mismatch"}
              />
            </div>
          </>
        ) : null}

        {sourcePreview ? (
          <MismatchSourceDrawer
            caseId={caseId}
            detail={detail}
            mismatch={sourcePreview.mismatch}
            evidence={sourcePreview.evidence}
            mode={
              isVerifiedCheck(sourcePreview.mismatch) ? "verified" : "mismatch"
            }
            onClose={() => setSourcePreview(null)}
          />
        ) : null}
      </div>
    </AppShell>
  );
}
