"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import {
  Activity,
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Database,
  Eye,
  FileText,
  Loader2,
  RotateCw,
  ShieldCheck,
  TriangleAlert,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import styles from "@/components/cases/CaseDetailPage.module.css";

type CaseSection = "documents" | "compliance" | "activity";
type ViewerMode = "preview" | "data";

export type RedesignedDocumentCard = {
  id: string;
  type: string;
  fileName: string;
  pageLabel: string;
  pageCount: number;
  hasIssue: boolean;
  issueCount: number;
};

type CaseDetailRedesignProps = {
  caseId: string;
  caseSlug: string;
  caseName: string;
  parentName: string;
  poNumber: string | null;
  invoiceNumber: string | null;
  dateLabel: string;
  amountLabel: string | null;
  uploadedLabel: string;
  statusLabel: string;
  status: string;
  showActions: boolean;
  canApprove: boolean;
  analysisIntegrityBlocked: boolean;
  approvalBlockedReason?: string | null;
  decisionUpdating: boolean;
  decisionError: string | null;
  onDecision: (decision: "accepted" | "rejected") => void;
  documents: RedesignedDocumentCard[];
  activeDocumentId: string | null;
  onSelectDocument: (documentId: string) => void;
  mismatchCount: number;
  pendingMismatchCount: number;
  reviewTitle: string;
  reviewDescription: string;
  missingDocumentLabels: string[];
  intelligenceContent?: ReactNode;
  complianceCount: number;
  complianceContent: ReactNode;
  activityContent: ReactNode;
  viewerMode: ViewerMode;
  onViewerModeChange: (mode: ViewerMode) => void;
  sourceLabel: string;
  sourceReference: string;
  previewNode: ReactNode;
  dataNode: ReactNode;
  previewFocusLabel?: string | null;
  onClearPreviewFocus: () => void;
  canPreviousPage: boolean;
  canNextPage: boolean;
  pageLabel: string;
  onPreviousPage: () => void;
  onNextPage: () => void;
  zoom: number;
  canZoomOut: boolean;
  canZoomIn: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onResetZoom: () => void;
};

function getStatusClass(status: string) {
  if (status === "accepted") return styles.redesignStatusAccepted;
  if (status === "rejected") return styles.redesignStatusRejected;
  if (status === "failed") return styles.redesignStatusRejected;
  return styles.redesignStatusReview;
}

export function CaseDetailRedesign({
  caseId,
  caseSlug,
  caseName,
  parentName,
  poNumber,
  invoiceNumber,
  dateLabel,
  amountLabel,
  uploadedLabel,
  statusLabel,
  status,
  showActions,
  canApprove,
  analysisIntegrityBlocked,
  approvalBlockedReason,
  decisionUpdating,
  decisionError,
  onDecision,
  documents,
  activeDocumentId,
  onSelectDocument,
  mismatchCount,
  pendingMismatchCount,
  reviewTitle,
  reviewDescription,
  missingDocumentLabels,
  intelligenceContent,
  complianceCount,
  complianceContent,
  activityContent,
  viewerMode,
  onViewerModeChange,
  sourceLabel,
  sourceReference,
  previewNode,
  dataNode,
  previewFocusLabel,
  onClearPreviewFocus,
  canPreviousPage,
  canNextPage,
  pageLabel,
  onPreviousPage,
  onNextPage,
  zoom,
  canZoomOut,
  canZoomIn,
  onZoomOut,
  onZoomIn,
  onResetZoom,
}: CaseDetailRedesignProps) {
  const [section, setSection] = useState<CaseSection>("documents");
  const issueDocumentCount = documents.filter(
    (document) => document.hasIssue,
  ).length;
  const totalPages = documents.reduce(
    (total, document) => total + Math.max(1, document.pageCount),
    0,
  );
  const isMismatchFree =
    mismatchCount === 0 &&
    missingDocumentLabels.length === 0 &&
    !analysisIntegrityBlocked;

  return (
    <div className={styles.redesignPage}>
      <header className={styles.redesignHeader}>
        <div className={styles.redesignCrumb}>
          <Link href="/cases">All Cases</Link>
          <span>/</span>
          <strong>{caseSlug}</strong>
        </div>
        <div className={styles.redesignHeaderRow}>
          <Link
            href="/cases"
            className={styles.redesignBack}
            aria-label="Back to cases"
          >
            <ArrowLeft />
          </Link>
          <h1 title={caseName}>{caseName}</h1>
          <span
            className={`${styles.redesignStatus} ${getStatusClass(status)}`}
          >
            {statusLabel}
          </span>
          <div className={styles.redesignHeaderActions}>
            {showActions ? (
              <>
                <button
                  type="button"
                  className={styles.redesignButtonDanger}
                  disabled={decisionUpdating}
                  onClick={() => onDecision("rejected")}
                >
                  <X /> Reject
                </button>
                <button
                  type="button"
                  className={styles.redesignButtonPrimary}
                  disabled={decisionUpdating || !canApprove}
                  title={
                    canApprove ? undefined : approvalBlockedReason || undefined
                  }
                  onClick={() => onDecision("accepted")}
                >
                  {decisionUpdating ? (
                    <Loader2 className={styles.redesignSpinner} />
                  ) : (
                    <Check />
                  )}{" "}
                  Approve case
                </button>
              </>
            ) : null}
          </div>
        </div>
        <div className={styles.redesignMeta}>
          <span>{parentName}</span>
          <i>·</i>
          <span>{poNumber || "PO not detected"}</span>
          <i>·</i>
          <span>{invoiceNumber || "Invoice not detected"}</span>
          <i>·</i>
          <span>{dateLabel}</span>
          {amountLabel ? (
            <>
              <i>·</i>
              <span>{amountLabel}</span>
            </>
          ) : null}
          <i>·</i>
          <span>{uploadedLabel}</span>
        </div>
        <nav className={styles.redesignTabs} aria-label="Case detail sections">
          <button
            type="button"
            className={section === "documents" ? styles.redesignTabActive : ""}
            onClick={() => setSection("documents")}
          >
            Documents & data
          </button>
          <button
            type="button"
            className={section === "compliance" ? styles.redesignTabActive : ""}
            onClick={() => setSection("compliance")}
          >
            Compliance <span>{complianceCount}</span>
          </button>
          <button
            type="button"
            className={section === "activity" ? styles.redesignTabActive : ""}
            onClick={() => setSection("activity")}
          >
            Activity
          </button>
        </nav>
      </header>

      {decisionError ? (
        <div className={styles.redesignDecisionError}>{decisionError}</div>
      ) : null}

      {section === "documents" ? (
        <>
          {intelligenceContent ? (
            <div className={styles.redesignIntelligenceStack}>
              {intelligenceContent}
            </div>
          ) : null}
          <section className={styles.redesignMetrics} aria-label="Case summary">
            <article>
              <span>Packet</span>
              <strong>
                {documents.length} <small>documents</small>
              </strong>
              <p>{totalPages} pages classified</p>
            </article>
            {analysisIntegrityBlocked &&
            mismatchCount === 0 &&
            missingDocumentLabels.length === 0 ? (
              <article
                className={`${styles.redesignMetricCard} ${styles.redesignMetricAlert}`}
                title={approvalBlockedReason || undefined}
              >
                <span>Analysis</span>
                <strong>Incomplete</strong>
                <p>Approval is blocked</p>
              </article>
            ) : isMismatchFree ? (
              <article
                className={`${styles.redesignMetricCard} ${styles.redesignMetricClear}`}
              >
                <span>Mismatches</span>
                <strong>Clean</strong>
                <p>No issues found</p>
              </article>
            ) : (
              <Link
                href={`/cases/${caseId}/mismatches`}
                title={`${reviewTitle}: ${reviewDescription}`}
                className={`${styles.redesignMetricCard} ${styles.redesignMetricAlert}`}
              >
                <span>
                  {missingDocumentLabels.length
                    ? "Missing documents"
                    : "Mismatches"}
                </span>
                <strong>{missingDocumentLabels.length || mismatchCount}</strong>
                <p>
                  {missingDocumentLabels.length
                    ? missingDocumentLabels.join(", ")
                    : pendingMismatchCount
                      ? `${pendingMismatchCount} need a decision`
                      : "every issue reviewed"}
                </p>
                <b>
                  {missingDocumentLabels.length
                    ? "Review required files"
                    : "Review mismatches"}{" "}
                  <ChevronRight />
                </b>
              </Link>
            )}
            <article>
              <span>Compliance</span>
              <strong>
                {complianceCount} <small>checks</small>
              </strong>
              <p>
                {complianceCount
                  ? "extracted PO clauses"
                  : "no clauses detected"}
              </p>
            </article>
            <article>
              <span>Invoice value</span>
              <strong>{amountLabel || "—"}</strong>
              <p
                className={
                  issueDocumentCount
                    ? styles.redesignMetricWarning
                    : styles.redesignMetricGood
                }
              >
                {issueDocumentCount
                  ? `${issueDocumentCount} document${issueDocumentCount === 1 ? "" : "s"} in a mismatch`
                  : "packet values are consistent"}
              </p>
            </article>
          </section>

          <section className={styles.redesignSplit}>
            <aside
              className={styles.redesignDocumentPane}
              aria-label="Documents in packet"
            >
              <div className={styles.redesignPaneHeader}>
                Documents in packet <span>{documents.length}</span>
              </div>
              <div className={styles.redesignDocumentList}>
                {documents.map((document) => (
                  <button
                    type="button"
                    key={document.id}
                    className={
                      activeDocumentId === document.id
                        ? styles.redesignDocumentActive
                        : ""
                    }
                    onClick={() => onSelectDocument(document.id)}
                  >
                    <span className={styles.redesignDocumentIcon}>
                      <FileText />
                      <i
                        className={
                          document.hasIssue
                            ? styles.redesignDocumentToneBad
                            : styles.redesignDocumentToneGood
                        }
                      />
                    </span>
                    <span className={styles.redesignDocumentCopy}>
                      <strong>{document.type}</strong>
                      <span>{document.fileName}</span>
                      <small>
                        <i
                          className={
                            document.hasIssue
                              ? styles.redesignDocumentDotBad
                              : styles.redesignDocumentDotGood
                          }
                        />{" "}
                        {document.pageLabel} ·{" "}
                        {document.issueCount > 0
                          ? `${document.issueCount} issue${document.issueCount === 1 ? "" : "s"} found`
                          : "No issues found"}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </aside>

            <main className={styles.redesignViewerPane}>
              <div className={styles.redesignViewerToolbar}>
                <div className={styles.redesignViewerSegment}>
                  <button
                    type="button"
                    className={
                      viewerMode === "preview"
                        ? styles.redesignViewerSegmentActive
                        : ""
                    }
                    onClick={() => onViewerModeChange("preview")}
                  >
                    <Eye /> Original
                  </button>
                  <button
                    type="button"
                    className={
                      viewerMode === "data"
                        ? styles.redesignViewerSegmentActive
                        : ""
                    }
                    onClick={() => onViewerModeChange("data")}
                  >
                    <Database /> Extracted data
                  </button>
                </div>
                <span
                  className={styles.redesignViewerReference}
                  title={sourceReference}
                >
                  {sourceReference}
                </span>
                {previewFocusLabel && viewerMode === "preview" ? (
                  <button
                    type="button"
                    className={styles.redesignFocusChip}
                    onClick={onClearPreviewFocus}
                    title="Clear PDF highlight"
                  >
                    <i /> {previewFocusLabel} <X />
                  </button>
                ) : null}
                <span className={styles.redesignViewerSpacer} />
                {viewerMode === "preview" ? (
                  <>
                    <div className={styles.redesignPageControls}>
                      <button
                        type="button"
                        disabled={!canPreviousPage}
                        onClick={onPreviousPage}
                        aria-label="Previous page"
                      >
                        <ChevronLeft />
                      </button>
                      <span>{pageLabel}</span>
                      <button
                        type="button"
                        disabled={!canNextPage}
                        onClick={onNextPage}
                        aria-label="Next page"
                      >
                        <ChevronRight />
                      </button>
                    </div>
                    <div className={styles.redesignZoomControls}>
                      <button
                        type="button"
                        disabled={!canZoomOut}
                        onClick={onZoomOut}
                        aria-label="Zoom out"
                      >
                        <ZoomOut />
                      </button>
                      <span>{Math.round(zoom * 100)}%</span>
                      <button
                        type="button"
                        disabled={!canZoomIn}
                        onClick={onZoomIn}
                        aria-label="Zoom in"
                      >
                        <ZoomIn />
                      </button>
                      <button
                        type="button"
                        onClick={onResetZoom}
                        disabled={zoom === 1}
                        aria-label="Reset zoom"
                      >
                        <RotateCw />
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
              <div
                className={styles.redesignViewerStage}
                data-view={viewerMode}
              >
                {viewerMode === "preview" ? previewNode : dataNode}
              </div>
              <div className={styles.redesignViewerFooter}>
                <span>{sourceLabel}</span>
                <span>
                  Click an extracted value to reveal it in the original PDF.
                </span>
              </div>
            </main>
          </section>
        </>
      ) : section === "compliance" ? (
        <main className={styles.redesignScrollSection}>
          <div className={styles.redesignSectionHeading}>
            <ShieldCheck />
            <div>
              <h2>Compliance checks</h2>
              <p>Purchase-order clauses checked against the packet.</p>
            </div>
          </div>
          {complianceContent}
        </main>
      ) : (
        <main className={styles.redesignScrollSection}>
          <div className={styles.redesignSectionHeading}>
            <Activity />
            <div>
              <h2>Case activity</h2>
              <p>Important analysis and decision events for this packet.</p>
            </div>
          </div>
          {activityContent}
          <div className={styles.redesignAuditNote}>
            <TriangleAlert /> Every extracted value, mismatch and decision
            remains on record after the case is approved or rejected.
          </div>
        </main>
      )}
    </div>
  );
}
