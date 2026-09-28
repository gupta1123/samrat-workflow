"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import {
  Copy,
  FilePlus2,
  FileSearch,
  Loader2,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import {
  findDocumentSourceFile,
  getMismatchDocumentPageRange,
  getMismatchEvidenceFocus,
  isImageFile,
} from "@/components/cases/MismatchSourceDrawer";
import {
  getEvidenceDocumentRole,
  getFieldLabel,
  type MismatchEvidence,
  type MismatchRecord,
} from "@/components/cases/CaseMismatchPage";
import { PdfEvidencePreview } from "@/components/cases/PdfEvidencePreview";
import styles from "@/components/cases/CaseMismatchPage.module.css";
import {
  fetchCaseFileSignedUrlPreferCache,
  type SavedCaseDetail,
} from "@/lib/case-persistence";
import { DOCUMENT_READABILITY_FIELD } from "@/lib/document-readability";
import { EXTRACTION_VERIFICATION_FIELD } from "@/lib/extraction-verification";
import { INVOICE_NUMBER_REQUIRED_FIELD } from "@/lib/invoice-approval";
import {
  MISSING_DOCUMENTS_FIELD,
  readMissingDocumentGroups,
} from "@/lib/missing-documents";
import { DUPLICATE_INVOICE_FIELD } from "@/lib/duplicate-invoice";

type MismatchComparePaneProps = {
  caseId: string;
  detail: SavedCaseDetail;
  mismatch: MismatchRecord;
  evidence: MismatchEvidence[];
  mode?: "mismatch" | "verified";
};

const ZOOM_MIN = 0.75;
const ZOOM_MAX = 1.5;
const ZOOM_STEP = 0.25;

function EvidencePage({
  caseId,
  detail,
  mismatch,
  evidence,
  zoom,
}: {
  caseId: string;
  detail: SavedCaseDetail;
  mismatch: MismatchRecord;
  evidence: MismatchEvidence;
  zoom: number;
}) {
  const sourceFile = useMemo(
    () => findDocumentSourceFile(detail, evidence.document),
    [detail, evidence.document],
  );
  const sourceFocus = useMemo(
    () => getMismatchEvidenceFocus(mismatch, evidence),
    [evidence, mismatch],
  );
  const pageRange = useMemo(
    () => getMismatchDocumentPageRange(evidence.document),
    [evidence.document],
  );
  const [pageNumber, setPageNumber] = useState(sourceFocus.pageNumber);
  const [signedUrl, setSignedUrl] = useState(sourceFile?.signedUrl ?? null);
  const [sourceError, setSourceError] = useState<string | null>(null);

  useEffect(() => {
    setPageNumber(sourceFocus.pageNumber);
  }, [sourceFocus.pageNumber, mismatch.id]);

  useEffect(() => {
    let active = true;
    setSourceError(null);
    setSignedUrl(sourceFile?.signedUrl ?? null);

    if (!sourceFile) {
      setSourceError("Source file could not be matched.");
      return () => {
        active = false;
      };
    }

    if (!sourceFile.signedUrl) {
      fetchCaseFileSignedUrlPreferCache(caseId, sourceFile.id)
        .then((result) => {
          if (active) setSignedUrl(result.signedUrl);
        })
        .catch((loadError) => {
          if (!active) return;
          setSourceError(
            loadError instanceof Error
              ? loadError.message
              : "Unable to load source preview.",
          );
        });
    }

    return () => {
      active = false;
    };
  }, [caseId, sourceFile]);

  const title = getEvidenceDocumentRole(evidence.document);
  const sourceName =
    sourceFile?.originalName ||
    evidence.document?.sourceFileName ||
    "Source document";

  return (
    <article className={styles.comparePage}>
      <div className={styles.comparePageHeader}>
        <div>
          <strong>{title}</strong>
          <span title={sourceName}>{sourceName}</span>
        </div>
        <span>Page {pageNumber}</span>
      </div>
      <div className={styles.comparePageBody}>
        {sourceError ? (
          <div className={styles.compareEmpty}>
            <FileSearch />
            <strong>Preview unavailable</strong>
            <span>{sourceError}</span>
          </div>
        ) : signedUrl ? (
          isImageFile(sourceFile) ? (
            <div className={styles.compareImageStage}>
              <Image
                src={signedUrl}
                alt={`${title} source`}
                width={1200}
                height={1600}
                unoptimized
                className={styles.compareImage}
                style={{ width: `${zoom * 100}%` }}
              />
            </div>
          ) : (
            <PdfEvidencePreview
              url={signedUrl}
              pageNumber={pageNumber}
              zoom={zoom}
              highlightText={sourceFocus.queries[0]}
              highlightQueries={sourceFocus.queries}
              highlightLabel={getFieldLabel(mismatch.fieldName)}
              highlightMode={sourceFocus.highlightMode}
              searchPageStart={pageRange.start}
              searchPageEnd={pageRange.end}
              onHighlightPageChange={setPageNumber}
            />
          )
        ) : (
          <div className={styles.compareLoading}>
            <Loader2 />
            Loading source page…
          </div>
        )}
      </div>
    </article>
  );
}

export function MismatchComparePane({
  caseId,
  detail,
  mismatch,
  evidence,
  mode = "mismatch",
}: MismatchComparePaneProps) {
  const displayedEvidence = evidence.slice(0, 2);
  const [zoom, setZoom] = useState(1);
  const missingDocumentGroups = readMissingDocumentGroups(
    detail.case.processingMeta,
  );
  const isPageLevelWarning =
    mismatch.fieldName === DOCUMENT_READABILITY_FIELD ||
    mismatch.fieldName === INVOICE_NUMBER_REQUIRED_FIELD ||
    mismatch.fieldName === EXTRACTION_VERIFICATION_FIELD;

  useEffect(() => {
    setZoom(1);
  }, [mismatch.id]);

  const sourceTitle = displayedEvidence
    .map((entry) => getEvidenceDocumentRole(entry.document))
    .join(" ↔ ");

  if (mismatch.fieldName === DUPLICATE_INVOICE_FIELD) {
    return (
      <section
        className={styles.comparePane}
        aria-label="Duplicate invoice number"
      >
        <div className={styles.compareToolbar}>
          <div className={styles.compareToolbarTitle}>
            <strong>Duplicate invoice</strong>
            <span>
              The same vendor invoice was uploaded more than once
            </span>
          </div>
        </div>
        <div className={`${styles.compareStage} ${styles.compareStageSingle}`}>
          <div className={styles.compareEmpty}>
            <Copy />
            <strong>Confirm a single booking</strong>
            <span>
              {(mismatch.values ?? [])
                .map((entry) => String(entry.value ?? "").trim())
                .filter(Boolean)
                .join(" ") ||
                "This invoice number appears more than once in this packet."}
            </span>
            {mismatch.fixPlan ? <span>{mismatch.fixPlan}</span> : null}
          </div>
        </div>
      </section>
    );
  }

  if (mismatch.fieldName === MISSING_DOCUMENTS_FIELD) {
    return (
      <section
        className={styles.comparePane}
        aria-label="Missing required documents"
      >
        <div className={styles.compareToolbar}>
          <div className={styles.compareToolbarTitle}>
            <strong>Required documents</strong>
            <span>
              No source page exists for a document that was not uploaded
            </span>
          </div>
        </div>
        <div className={`${styles.compareStage} ${styles.compareStageSingle}`}>
          <div className={styles.compareEmpty}>
            <FilePlus2 />
            <strong>Add the missing documents</strong>
            <span>
              {missingDocumentGroups.length
                ? `${missingDocumentGroups.join(", ")} must be added before this case can be approved.`
                : "The required files must be added before this case can be approved."}
            </span>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      className={styles.comparePane}
      aria-label={
        mode === "verified"
          ? "Verified source documents"
          : "Highlighted mismatch sources"
      }
    >
      <div className={styles.compareToolbar}>
        <div className={styles.compareToolbarTitle}>
          <strong>{sourceTitle || "Source evidence"}</strong>
          <span>
            {isPageLevelWarning
              ? "Inspect the affected source page"
              : mode === "verified"
                ? displayedEvidence.length > 1
                  ? "Verified value highlighted on both source pages"
                  : "Verified value highlighted on the source page"
                : displayedEvidence.length > 1
                  ? "Mismatch highlighted on both source pages"
                  : "Mismatch highlighted on the source page"}
          </span>
        </div>
        <div
          className={styles.compareZoom}
          role="group"
          aria-label="Comparison zoom"
        >
          <button
            type="button"
            onClick={() =>
              setZoom((current) => Math.max(ZOOM_MIN, current - ZOOM_STEP))
            }
            disabled={zoom <= ZOOM_MIN}
            aria-label="Zoom out"
          >
            <ZoomOut />
          </button>
          <output>{Math.round(zoom * 100)}%</output>
          <button
            type="button"
            onClick={() =>
              setZoom((current) => Math.min(ZOOM_MAX, current + ZOOM_STEP))
            }
            disabled={zoom >= ZOOM_MAX}
            aria-label="Zoom in"
          >
            <ZoomIn />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            disabled={zoom === 1}
            aria-label="Reset zoom"
          >
            <RotateCw />
          </button>
        </div>
      </div>

      <div
        className={`${styles.compareStage} ${
          displayedEvidence.length === 1 ? styles.compareStageSingle : ""
        }`}
      >
        {displayedEvidence.length > 0 ? (
          displayedEvidence.map((entry) => (
            <EvidencePage
              key={entry.key}
              caseId={caseId}
              detail={detail}
              mismatch={mismatch}
              evidence={entry}
              zoom={zoom}
            />
          ))
        ) : (
          <div className={styles.compareEmpty}>
            <FileSearch />
            <strong>No source evidence</strong>
            <span>
              {mode === "verified"
                ? "This check has no stored source location."
                : "This mismatch has no stored source location."}
            </span>
          </div>
        )}

        {displayedEvidence.length > 1 ? (
          <div
            key={mismatch.id}
            className={`${styles.compareConnector} ${
              mode === "verified"
                ? styles.compareConnectorMatched
                : styles.compareConnectorMismatch
            }`}
            aria-hidden="true"
          >
            <span className={styles.compareConnectorLine} />
            <strong>
              {mode === "verified" ? "Matches" : "Does not match"}
            </strong>
            <span className={styles.compareConnectorLine} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
