"use client";

import Link from "next/link";
import { useState, type CSSProperties, type ReactNode } from "react";
import {
  Activity,
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Database,
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
  fieldCount?: number;
  comparisonState?: "matched" | "mismatch" | "absent";
  comparisonValue?: string;
  chainRole?: "approval" | "supporting";
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
  comparisonFieldLabel?: string | null;
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
  showPageControls: boolean;
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
  comparisonFieldLabel,
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
  showPageControls,
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

  const cleanTitle =
    parentName && parentName !== "Procurement packet"
      ? parentName
      : caseName.includes(" / ")
        ? caseName.split(" / ")[0]
        : caseName;

  const hasSellerChain = documents.some((document) => document.chainRole === "supporting");
  const approvalDocuments = hasSellerChain
    ? documents.filter((document) => document.chainRole !== "supporting")
    : documents;
  const supportingDocuments = hasSellerChain
    ? documents.filter((document) => document.chainRole === "supporting")
    : [];

  const renderDocumentCard = (document: RedesignedDocumentCard, index: number) => {
    const isSelected = activeDocumentId === document.id;
    const comparisonClass =
      document.comparisonState === "matched"
        ? styles.topDocCardComparedMatched
        : document.comparisonState === "mismatch"
          ? styles.topDocCardComparedMismatch
          : document.comparisonState === "absent"
            ? styles.topDocCardComparedAbsent
            : "";
    const comparisonStatus =
      document.comparisonState === "matched"
        ? "Matched"
        : document.comparisonState === "mismatch"
          ? "Mismatch"
          : document.comparisonState === "absent"
            ? "Not present"
            : null;
    const comparisonValue = document.comparisonValue?.trim() || "—";

    return (
      <button
        type="button"
        key={document.id}
        className={`${styles.topDocCard} ${isSelected ? styles.topDocCardActive : ""} ${comparisonClass} ${
          document.chainRole === "supporting" ? styles.topDocCardSupporting : ""
        }`}
        onClick={() => onSelectDocument(document.id)}
        aria-label={
          comparisonFieldLabel && comparisonStatus
            ? `${document.type}: ${comparisonFieldLabel} — ${comparisonValue}; ${comparisonStatus}`
            : document.chainRole === "supporting"
              ? `${document.type}, supporting source-chain document`
              : document.type
        }
      >
        <div className={styles.topDocCardHeader}>
          <span className={styles.topDocNum}>{index + 1}</span>
          <span
            className={`${styles.topDocDot} ${
              document.comparisonState === "absent"
                ? styles.topDocDotMuted
                : document.comparisonState === "mismatch" || (!document.comparisonState && document.hasIssue)
                  ? styles.topDocDotBad
                  : styles.topDocDotGood
            }`}
          />
        </div>
        <div className={styles.topDocTitle} title={document.type}>{document.type}</div>
        <div
          className={comparisonFieldLabel ? styles.topDocValue : styles.topDocSub}
          title={comparisonFieldLabel ? comparisonValue : undefined}
        >
          {comparisonFieldLabel
            ? comparisonValue
            : document.fieldCount
              ? `${document.fieldCount} fields`
              : document.pageLabel}
        </div>
      </button>
    );
  };

  return (
    <div className={styles.redesignPage}>
      <header className={styles.compactHeader}>
        <div className={styles.compactHeaderLeft}>
          <Link href="/cases" className={styles.compactBack} aria-label="Back to cases" title="Back to All Cases">
            <ArrowLeft />
          </Link>
          <div className={styles.compactInfo}>
            <div className={styles.compactTitleRow}>
              <h1 title={caseName}>{cleanTitle}</h1>
              <span className={`${styles.redesignStatus} ${getStatusClass(status)}`}>{statusLabel}</span>
            </div>
            <div className={styles.compactMetaRow}>
              {poNumber ? <span>PO <strong>{poNumber}</strong></span> : null}
              {poNumber && invoiceNumber ? <i>·</i> : null}
              {invoiceNumber ? <span>Invoice <strong>{invoiceNumber}</strong></span> : null}
              {amountLabel ? <><i>·</i><span>Amount <strong className={styles.compactAmount}>{amountLabel}</strong></span></> : null}
            </div>
          </div>
        </div>

        <div className={styles.compactHeaderRight}>
          <nav className={styles.compactTabs} aria-label="Case detail sections">
            <button
              type="button"
              className={section === "documents" ? styles.compactTabActive : styles.compactTab}
              onClick={() => setSection("documents")}
            >
              Documents
            </button>
            <button
              type="button"
              className={section === "compliance" ? styles.compactTabActive : styles.compactTab}
              onClick={() => setSection("compliance")}
            >
              Compliance {complianceCount > 0 && <span className={styles.compactTabBadge}>{complianceCount}</span>}
            </button>
            <button
              type="button"
              className={section === "activity" ? styles.compactTabActive : styles.compactTab}
              onClick={() => setSection("activity")}
            >
              Activity
            </button>
          </nav>

          <div className={styles.redesignHeaderActions}>
            <Link
              href={mismatchCount > 0 ? `/cases/${caseId}/mismatches` : `/cases/${caseId}/mismatches?tab=sap`}
              className={`${styles.redesignButtonOutline} ${styles.compactMismatchAction}`}
              aria-label={mismatchCount > 0 ? `Review ${mismatchCount} ${mismatchCount === 1 ? "mismatch" : "mismatches"}` : "Post to SAP"}
            >
              {mismatchCount > 0 ? (
                <><TriangleAlert /> {mismatchCount} {mismatchCount === 1 ? "mismatch" : "mismatches"}</>
              ) : (
                <><Database /> Post to SAP</>
              )}
            </Link>
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
                  title={canApprove ? undefined : approvalBlockedReason || undefined}
                  onClick={() => onDecision("accepted")}
                >
                  {decisionUpdating ? <Loader2 className={styles.redesignSpinner} /> : <Check />} Approve
                </button>
              </>
            ) : null}
          </div>
        </div>
      </header>

      {decisionError ? <div className={styles.redesignDecisionError}>{decisionError}</div> : null}

      {section === "documents" ? (
        <>
          {intelligenceContent ? (
            <div className={styles.redesignIntelligenceStack}>
              {intelligenceContent}
            </div>
          ) : null}

          <section
            className={`${styles.topDocumentStrip} ${
              comparisonFieldLabel ? styles.topDocumentStripComparing : ""
            }`}
            aria-label="Documents in packet"
          >
            {hasSellerChain ? (
              <div className={styles.topDocumentGroup}>
                <div className={styles.topDocumentGroupHeader}>
                  <span className={styles.topDocumentGroupTitle}>Approval documents</span>
                  <span className={styles.topDocumentGroupHint}>Used for reconciliation</span>
                </div>
                <div
                  className={styles.topDocumentGrid}
                  style={{ "--top-document-columns": Math.max(4, Math.min(approvalDocuments.length, 10)) } as CSSProperties}
                >
                  {approvalDocuments.map((document) => renderDocumentCard(document, documents.indexOf(document)))}
                </div>
              </div>
            ) : (
              <div
                className={styles.topDocumentGrid}
                style={{ "--top-document-columns": Math.max(7, Math.min(documents.length, 10)) } as CSSProperties}
              >
                {documents.map(renderDocumentCard)}
              </div>
            )}

            {supportingDocuments.length ? (
              <div className={`${styles.topDocumentGroup} ${styles.topDocumentGroupSupporting}`}>
                <div className={styles.topDocumentGroupHeader}>
                  <span className={styles.topDocumentGroupTitle}>Source chain</span>
                  <span className={styles.topDocumentSupportingBadge}>Supporting only</span>
                </div>
                <div
                  className={styles.topDocumentGrid}
                  style={{ "--top-document-columns": Math.max(3, Math.min(supportingDocuments.length, 10)) } as CSSProperties}
                >
                  {supportingDocuments.map((document) => renderDocumentCard(document, documents.indexOf(document)))}
                </div>
              </div>
            ) : null}
          </section>

          <section className={styles.splitWorkspace}>
            <div className={styles.splitPreviewPane}>
              <div className={styles.splitPreviewHeader}>
                <div className={styles.splitDocTitleBlock}>
                  <span className={styles.splitDocRef} title={sourceReference}>{sourceReference}</span>
                </div>
                <div className={styles.splitPreviewControls}>
                  {showPageControls ? <div className={styles.redesignPageControls}>
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
                  </div> : null}
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
                </div>
              </div>

              <div className={styles.splitPreviewStage}>
                {previewNode}
              </div>
            </div>

            <div className={styles.splitDataPane}>
              {dataNode}
            </div>
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
            <TriangleAlert /> Every extracted value, mismatch and decision remains on record after the case is approved or rejected.
          </div>
        </main>
      )}
    </div>
  );
}
