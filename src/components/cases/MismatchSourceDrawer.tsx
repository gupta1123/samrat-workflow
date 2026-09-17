"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { FileSearch, Move, RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";

import {
  getEvidenceDocumentRole,
  getFieldLabel,
  type MismatchEvidence,
  type MismatchRecord,
} from "@/components/cases/CaseMismatchPage";
import styles from "@/components/cases/CaseMismatchPage.module.css";
import { PdfEvidencePreview } from "@/components/cases/PdfEvidencePreview";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchCaseFileSignedUrlPreferCache,
  type SavedCaseDetail,
} from "@/lib/case-persistence";
import { DOCUMENT_READABILITY_FIELD } from "@/lib/document-readability";
import { EXTRACTION_VERIFICATION_FIELD } from "@/lib/extraction-verification";
import { INVOICE_NUMBER_REQUIRED_FIELD } from "@/lib/invoice-approval";
import { WEIGHT_CALCULATION_FIELD } from "@/lib/weight-calculation";
import { isLineItemMismatchField } from "@/lib/line-items";
import type { CommercialLineItem } from "@/types/pipeline";

type MismatchSourceDrawerProps = {
  caseId: string;
  detail: SavedCaseDetail;
  mismatch: MismatchRecord;
  evidence: MismatchEvidence;
  mode?: "mismatch" | "verified";
  onClose: () => void;
};

const SOURCE_ZOOM_DEFAULT = 1;
const SOURCE_ZOOM_MIN = 0.75;
const SOURCE_ZOOM_MAX = 1.5;
const SOURCE_ZOOM_STEP = 0.25;

function normalizeSourceName(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toSourceQuery(value: unknown) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value))
    return value
      .map((entry) => String(entry ?? ""))
      .join(" ")
      .trim();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}

export function getMismatchDocumentPageRange(
  document: SavedCaseDetail["documents"][number] | undefined,
) {
  const sourceText = [
    document?.sourceHint,
    document?.sourceFileName,
    document?.title,
  ]
    .filter(Boolean)
    .join(" ");
  const explicitRange = sourceText.match(
    /\bpages?\s+(\d+)(?:\s*[-–—]\s*(\d+))?/i,
  );
  const start = Math.max(1, Number(explicitRange?.[1]) || 1);
  const explicitEnd = Number(explicitRange?.[2]);
  const end =
    Number.isFinite(explicitEnd) && explicitEnd >= start
      ? explicitEnd
      : start + Math.max(1, document?.pageCount || 1) - 1;
  return { start, end };
}

export function findDocumentSourceFile(
  detail: SavedCaseDetail,
  document: MismatchEvidence["document"],
) {
  // A missing or unmatched document must never borrow an unrelated uploaded
  // file merely because the case contains only one file.
  if (!document) return null;

  const candidates = [
    document.sourceFileName,
    document.sourceHint,
    document.title,
  ]
    .map(normalizeSourceName)
    .filter(Boolean);

  const exact = detail.files.find((file) =>
    candidates.includes(normalizeSourceName(file.originalName)),
  );
  if (exact) return exact;

  const contained = detail.files.find((file) => {
    const fileName = normalizeSourceName(file.originalName);
    return candidates.some(
      (candidate) =>
        candidate.endsWith(fileName) ||
        candidate.includes(` ${fileName}`) ||
        fileName.includes(candidate),
    );
  });
  if (contained) return contained;

  const pdfFiles = detail.files.filter(
    (file) =>
      file.mimeType === "application/pdf" || /\.pdf$/i.test(file.originalName),
  );
  if (pdfFiles.length === 1) return pdfFiles[0];
  return detail.files.length === 1 ? detail.files[0] : null;
}

function getLineNumber(value: unknown) {
  const text = String(value ?? "").trim();
  const match =
    text.match(/(?:^|\b)line\s+(\d+)\b/i) ?? text.match(/^(\d+)\s*:/);
  const parsed = Number(match?.[1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function findEvidenceLineItem(
  mismatch: MismatchRecord,
  evidence: MismatchEvidence,
): CommercialLineItem | null {
  const items = evidence.document?.lineItems ?? [];
  if (items.length === 0) return null;

  const lineNumber = getLineNumber(evidence.value);
  if (lineNumber) {
    return (
      items.find((item) => Number(item.lineNumber) === lineNumber) ??
      items[lineNumber - 1] ??
      null
    );
  }

  if (!isLineItemMismatchField(mismatch.fieldName)) return null;
  const prefix = String(evidence.value ?? "")
    .match(/^([^:]{2,80}):/)?.[1]
    ?.trim();
  const normalizedPrefix = normalizeSourceName(prefix);
  if (!normalizedPrefix) return null;
  return (
    items.find((item) => {
      const identity = normalizeSourceName(
        [item.description, item.itemCode, item.rawText]
          .filter(Boolean)
          .join(" "),
      );
      if (!identity) return false;
      return (
        identity.includes(normalizedPrefix) ||
        normalizedPrefix.includes(identity)
      );
    }) ?? null
  );
}

function getFieldSearchLabels(fieldName: string) {
  const aliases: Record<string, string[]> = {
    buyerGstin: ["Buyer GSTIN", "GSTIN"],
    supplierGstin: ["Supplier GSTIN", "GSTIN"],
    invoiceNumber: ["Invoice Number", "Invoice No"],
    referenceInvoiceNumber: [
      "Reference Invoice Number",
      "Invoice Number",
      "Invoice No",
    ],
    poNumber: ["PO Number", "PO No"],
    referencePoNumber: ["Reference PO Number", "PO Number", "PO No"],
    vehicleNumber: ["Vehicle Number", "Vehicle"],
    eWayBillNumber: ["E-Way Bill Number", "E-Way Bill No"],
    taxAmount: ["Tax Amount", "GST Amount", "IGST", "CGST", "SGST"],
    totalAmount: ["Total Amount", "Document Total", "Order Value", "Total"],
    subtotal: ["Subtotal", "Taxable Value", "Basic Value"],
    [WEIGHT_CALCULATION_FIELD]: [
      "Gross Weight",
      "Tare Weight",
      "Net Weight",
      "Gross",
      "Tare",
      "Net",
    ],
  };
  return Array.from(
    new Set([getFieldLabel(fieldName), ...(aliases[fieldName] ?? [])]),
  );
}

export function getMismatchEvidenceFocus(
  mismatch: MismatchRecord,
  evidence: MismatchEvidence,
) {
  const document = evidence.document;
  const pageRange = getMismatchDocumentPageRange(document);
  if (
    mismatch.fieldName === DOCUMENT_READABILITY_FIELD ||
    mismatch.fieldName === INVOICE_NUMBER_REQUIRED_FIELD ||
    mismatch.fieldName === EXTRACTION_VERIFICATION_FIELD
  ) {
    return {
      pageNumber: pageRange.start,
      queries: [],
      highlightMode: "text" as const,
    };
  }
  const lineItem = findEvidenceLineItem(mismatch, evidence);
  if (lineItem) {
    const itemPage = Number(lineItem.sourcePage);
    const pageNumber =
      Number.isFinite(itemPage) && itemPage > 0
        ? itemPage <= Math.max(1, document?.pageCount || 1)
          ? pageRange.start + itemPage - 1
          : itemPage
        : pageRange.start;
    const queries = [
      lineItem.description?.trim(),
      lineItem.itemCode?.trim(),
      lineItem.rawText?.trim(),
      toSourceQuery(evidence.value),
    ].filter((query): query is string => Boolean(query));
    return {
      pageNumber,
      queries: Array.from(new Set(queries)),
      highlightMode: "row" as const,
    };
  }

  const extractedValue = document?.extractedFields?.[mismatch.fieldName];
  const valueQuery =
    extractedValue !== null &&
    extractedValue !== undefined &&
    String(extractedValue).trim()
      ? toSourceQuery(extractedValue)
      : toSourceQuery(evidence.value);
  const labelledQueries = valueQuery
    ? getFieldSearchLabels(mismatch.fieldName).map(
        (label) => `${label} ${valueQuery}`,
      )
    : [];
  return {
    pageNumber: pageRange.start,
    queries: Array.from(
      new Set([...labelledQueries, valueQuery].filter(Boolean)),
    ),
    highlightMode: "text" as const,
  };
}

export function isImageFile(file: SavedCaseDetail["files"][number] | null) {
  if (!file) return false;
  return Boolean(
    file.mimeType?.startsWith("image/") ||
    /\.(?:png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(file.originalName),
  );
}

export function MismatchSourceDrawer({
  caseId,
  detail,
  mismatch,
  evidence,
  mode = "mismatch",
  onClose,
}: MismatchSourceDrawerProps) {
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
  const [zoom, setZoom] = useState(SOURCE_ZOOM_DEFAULT);
  const [signedUrl, setSignedUrl] = useState<string | null>(
    sourceFile?.signedUrl ?? null,
  );
  const [sourceError, setSourceError] = useState<string | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setPageNumber(sourceFocus.pageNumber);
    setZoom(SOURCE_ZOOM_DEFAULT);
  }, [mismatch.id, sourceFocus.pageNumber]);

  useEffect(() => {
    setZoom((current) =>
      Math.min(SOURCE_ZOOM_MAX, Math.max(SOURCE_ZOOM_MIN, current)),
    );
  }, []);

  useEffect(() => {
    let active = true;
    setSourceError(null);
    setSignedUrl(sourceFile?.signedUrl ?? null);
    if (!sourceFile) {
      setSourceError("The source file for this evidence could not be matched.");
      return () => {
        active = false;
      };
    }
    if (sourceFile.signedUrl) {
      return () => {
        active = false;
      };
    }

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

    return () => {
      active = false;
    };
  }, [caseId, sourceFile]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const documentTitle = getEvidenceDocumentRole(evidence.document);
  const sourceName =
    sourceFile?.originalName ||
    evidence.document?.sourceFileName ||
    "Source document";
  const sourceIsImage = isImageFile(sourceFile);
  const canHighlight =
    Boolean(sourceFile) && !sourceIsImage && sourceFocus.queries.length > 0;
  const rangeLabel =
    pageRange.start === pageRange.end
      ? `page ${pageRange.start}`
      : `pages ${pageRange.start}–${pageRange.end}`;
  const zoomOut = () => {
    setZoom((current) => Math.max(SOURCE_ZOOM_MIN, current - SOURCE_ZOOM_STEP));
  };
  const zoomIn = () => {
    setZoom((current) => Math.min(SOURCE_ZOOM_MAX, current + SOURCE_ZOOM_STEP));
  };

  return (
    <div
      className={styles.sourceOverlay}
      role="presentation"
      onMouseDown={onClose}
    >
      <aside
        ref={drawerRef}
        className={styles.sourceDrawer}
        role="dialog"
        aria-modal="true"
        aria-label={`${documentTitle} source preview`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.sourceDrawerHeader}>
          <div className={styles.sourceDrawerHeading}>
            <h2 className={styles.sourceDrawerTitle}>{documentTitle}</h2>
            <p className={styles.sourceDrawerMeta}>
              {sourceName} · {rangeLabel} · showing page {pageNumber}
            </p>
          </div>
          <div
            className={styles.sourceZoomControls}
            role="group"
            aria-label="Source preview zoom"
          >
            <button
              type="button"
              className={styles.sourceZoomButton}
              onClick={zoomOut}
              disabled={zoom <= SOURCE_ZOOM_MIN}
              aria-label="Zoom out source preview"
              title="Zoom out"
            >
              <ZoomOut />
            </button>
            <output className={styles.sourceZoomValue} aria-live="polite">
              {Math.round(zoom * 100)}%
            </output>
            <button
              type="button"
              className={styles.sourceZoomButton}
              onClick={zoomIn}
              disabled={zoom >= SOURCE_ZOOM_MAX}
              aria-label="Zoom in source preview"
              title="Zoom in"
            >
              <ZoomIn />
            </button>
            <button
              type="button"
              className={`${styles.sourceZoomButton} ${styles.sourceZoomReset}`}
              onClick={() => setZoom(SOURCE_ZOOM_DEFAULT)}
              disabled={zoom === SOURCE_ZOOM_DEFAULT}
              aria-label="Reset source preview zoom"
              title="Reset zoom"
            >
              <RotateCw />
            </button>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className={styles.sourceDrawerClose}
            onClick={onClose}
            aria-label="Close source preview"
            autoFocus
          >
            <X />
          </button>
        </header>

        <div className={styles.sourceHighlightNotice} role="status">
          <FileSearch />
          <div>
            <strong>
              {mode === "verified"
                ? "Verified value location"
                : "Exact mismatch location"}
            </strong>
            <span>
              {canHighlight
                ? "The matching value is highlighted in yellow."
                : "The source document is opened at the relevant location."}
            </span>
          </div>
          <span>Page {pageNumber}</span>
        </div>

        <div className={styles.sourceDrawerBody}>
          {sourceError ? (
            <div className={styles.sourcePreviewError}>
              <FileSearch />
              <strong>Source preview unavailable</strong>
              <span>{sourceError}</span>
            </div>
          ) : signedUrl ? (
            sourceIsImage ? (
              <div className={styles.sourceImageStage}>
                <div
                  className={styles.sourceImageZoom}
                  style={{ width: `${zoom * 100}%` }}
                >
                  <Image
                    src={signedUrl}
                    alt={`${documentTitle} source`}
                    width={1200}
                    height={1600}
                    unoptimized
                    className={styles.sourceImage}
                  />
                </div>
              </div>
            ) : (
              <>
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
                {zoom > SOURCE_ZOOM_DEFAULT ? (
                  <div className={styles.sourcePanHint} aria-hidden="true">
                    <Move />
                    Drag to inspect
                  </div>
                ) : null}
              </>
            )
          ) : (
            <div
              className={styles.sourcePreviewSkeleton}
              aria-label="Loading source preview"
            >
              <div className={styles.sourcePreviewPaper}>
                <div className="flex items-start justify-between gap-8">
                  <div className="space-y-2">
                    <Skeleton className="h-5 w-56 bg-slate-100" />
                    <Skeleton className="h-2.5 w-44 bg-slate-100" />
                    <Skeleton className="h-2.5 w-36 bg-slate-100" />
                  </div>
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-32 bg-slate-100" />
                    <Skeleton className="h-2.5 w-24 bg-slate-100" />
                  </div>
                </div>
                <div className={styles.sourceSkeletonRule} />
                {Array.from({ length: 9 }).map((_, index) => (
                  <div className={styles.sourceSkeletonRow} key={index}>
                    <Skeleton className="h-2.5 w-8 bg-slate-100" />
                    <Skeleton className="h-2.5 w-36 bg-slate-100" />
                    <Skeleton className="h-2.5 w-16 bg-slate-100" />
                    <Skeleton className="h-2.5 w-20 bg-slate-100" />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
