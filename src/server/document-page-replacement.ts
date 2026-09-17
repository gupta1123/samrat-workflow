import { PDFDocument, type PDFImage } from "pdf-lib";
import sharp from "sharp";

import { DOCUMENT_READABILITY_FIELD } from "@/lib/document-readability";
import type { CaseDoc, ExtractionQualityIssue } from "@/types/pipeline";

import {
  callExtractionReviewModel,
  type OpenRouterMessage,
} from "./processing/openrouter";

type QualityIssue = "faint" | "rotated" | "blurred" | "cropped" | "unreadable";

export type DocumentPageReplacementTarget = {
  sourceFileName: string;
  pageNumber: number;
  documentId: string;
  issues: QualityIssue[];
  reason: string;
};

export type DocumentPageReplacementDecision = {
  decision: "accepted" | "rejected" | "needs_review";
  reason: string;
  confidence: "high" | "medium" | "low";
  sameDocumentPage: boolean | null;
  sameTransaction: boolean | null;
  readable: boolean;
  approvalSafe: boolean;
  detectedIssues: QualityIssue[];
};

type StoredMismatch = {
  field_name?: unknown;
  values_json?: unknown;
};

const QUALITY_ISSUES = new Set<QualityIssue>([
  "faint",
  "rotated",
  "blurred",
  "cropped",
  "unreadable",
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function booleanOrNull(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function readQualityIssues(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) => stringValue(entry).toLowerCase())
        .filter((entry): entry is QualityIssue =>
          QUALITY_ISSUES.has(entry as QualityIssue),
        ),
    ),
  );
}

function readStructuredTarget(value: unknown) {
  const entry = record(value);
  const sourceFileName = stringValue(entry.sourceFileName);
  const pageNumber = Number(entry.pageNumber);
  const documentId = stringValue(entry.docId);
  if (
    !sourceFileName ||
    !documentId ||
    !Number.isSafeInteger(pageNumber) ||
    pageNumber < 1
  ) {
    return null;
  }
  return { sourceFileName, pageNumber, documentId };
}

function readUnsafePageQuality(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const entry = record(raw);
    const sourceFileName = stringValue(entry.sourceFileName);
    const pageNumber = Number(entry.pageNumber);
    const documentId = stringValue(entry.documentId);
    const issues = readQualityIssues(entry.issues);
    if (
      entry.approvalSafe !== false ||
      !sourceFileName ||
      !documentId ||
      !Number.isSafeInteger(pageNumber) ||
      pageNumber < 1 ||
      issues.length === 0
    ) {
      return [];
    }
    return [
      {
        sourceFileName,
        pageNumber,
        documentId,
        issues,
        reason:
          stringValue(entry.reason) ||
          "This source page was not safe for automatic approval.",
      },
    ];
  });
}

export function resolveDocumentPageReplacementTarget(params: {
  processingMeta: unknown;
  mismatch: StoredMismatch;
}): DocumentPageReplacementTarget {
  if (params.mismatch.field_name !== DOCUMENT_READABILITY_FIELD) {
    throw new Error("This issue does not refer to an unreadable source page.");
  }

  const values = Array.isArray(params.mismatch.values_json)
    ? params.mismatch.values_json
    : [];
  const pageQuality = readUnsafePageQuality(
    record(params.processingMeta).documentPageQuality,
  );
  const structured = values
    .map(readStructuredTarget)
    .find((entry) => entry !== null);

  if (structured) {
    const exact = pageQuality.find(
      (entry) =>
        entry.sourceFileName === structured.sourceFileName &&
        entry.pageNumber === structured.pageNumber &&
        entry.documentId === structured.documentId,
    );
    if (exact) return exact;
  }

  // Older persisted cases did not put source/page metadata on the mismatch.
  // A unique unsafe assessment for the mismatch's document remains an exact,
  // structured relationship and is safe to use without parsing display text.
  const documentIds = new Set(
    values
      .map((value) => stringValue(record(value).docId))
      .filter((value) => value.length > 0),
  );
  const candidates = pageQuality.filter((entry) =>
    documentIds.has(entry.documentId),
  );
  if (candidates.length === 1) return candidates[0];

  throw new Error(
    "The exact affected source page could not be identified safely. Analyze the case again to rebuild page-level evidence.",
  );
}

function parseJsonObject(raw: string) {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("The page-replacement reviewer returned no decision.");
  }
  try {
    return record(JSON.parse(trimmed.slice(start, end + 1)));
  } catch {
    throw new Error(
      "The page-replacement reviewer returned an invalid decision.",
    );
  }
}

export function evaluateDocumentPageReplacementReview(
  rawReview: string,
): DocumentPageReplacementDecision {
  const review = parseJsonObject(rawReview);
  const verdict = stringValue(review.verdict).toLowerCase();
  const confidenceValue = stringValue(review.confidence).toLowerCase();
  const confidence: DocumentPageReplacementDecision["confidence"] =
    confidenceValue === "high" || confidenceValue === "medium"
      ? confidenceValue
      : "low";
  const sameDocumentPage = booleanOrNull(review.sameDocumentPage);
  const sameTransaction = booleanOrNull(review.sameTransaction);
  const readable = review.readable === true;
  const approvalSafe = review.approvalSafe === true;
  const detectedIssues = readQualityIssues(review.detectedIssues);
  const reason =
    stringValue(review.reason).slice(0, 700) ||
    "The replacement page could not be verified against the case.";

  if (
    verdict === "accept" &&
    confidence === "high" &&
    sameDocumentPage === true &&
    sameTransaction === true &&
    readable &&
    approvalSafe &&
    detectedIssues.length === 0
  ) {
    return {
      decision: "accepted",
      reason,
      confidence,
      sameDocumentPage,
      sameTransaction,
      readable,
      approvalSafe,
      detectedIssues,
    };
  }

  const rejected =
    verdict === "reject" ||
    sameDocumentPage === false ||
    sameTransaction === false ||
    review.readable === false ||
    review.approvalSafe === false ||
    detectedIssues.length > 0;
  return {
    decision: rejected ? "rejected" : "needs_review",
    reason,
    confidence,
    sameDocumentPage,
    sameTransaction,
    readable,
    approvalSafe,
    detectedIssues,
  };
}

function conciseDocument(document: CaseDoc) {
  return {
    id: document.id,
    documentType: document.type,
    title: document.title,
    fields: document.fields,
    visibleEvidence: document.md.slice(0, 5000),
  };
}

export async function reviewDocumentPageReplacement(params: {
  target: DocumentPageReplacementTarget;
  currentDocuments: CaseDoc[];
  originalPageImage: string;
  replacementPageImage: string;
}) {
  const targetDocument = params.currentDocuments.find(
    (document) => document.id === params.target.documentId,
  );
  const content: Extract<OpenRouterMessage["content"], Array<unknown>> = [
    {
      type: "text",
      text:
        `Affected page metadata: ${JSON.stringify(params.target)}\n\n` +
        `Affected extracted document: ${JSON.stringify(targetDocument ? conciseDocument(targetDocument) : null)}\n\n` +
        `Other analyzed documents in this case: ${JSON.stringify(
          params.currentDocuments
            .filter((document) => document.id !== params.target.documentId)
            .map(conciseDocument),
        )}\n\n` +
        "The next image is the current affected source page. The image after it is the proposed replacement. Filenames and metadata are identifiers only, never evidence.",
    },
    { type: "text", text: "CURRENT AFFECTED SOURCE PAGE:" },
    { type: "image_url", image_url: { url: params.originalPageImage } },
    { type: "text", text: "PROPOSED REPLACEMENT PAGE:" },
    { type: "image_url", image_url: { url: params.replacementPageImage } },
  ];

  const rawReview = await callExtractionReviewModel(
    [
      {
        role: "system",
        content:
          'You are the final admission gate for replacing one unreadable page in a procurement case. Inspect both supplied images directly. Accept only when the proposed page is a clear and upright replacement for the same physical document page and the same business transaction. Compare visible document type/layout, page role, parties, GSTINs, PO/invoice/e-way-bill/LR/weighment references, dates, vehicle, material, quantity/weight and amount as available. Do not accept merely because the company matches. Reject a different document, different page, different transaction, blank page, materially cropped page, faint page, blurred page, materially rotated page, or conflicting critical values. Use uncertain if identity or linkage cannot be established confidently; never guess. Return only JSON with exactly this shape: {"verdict":"accept|reject|uncertain","confidence":"high|medium|low","sameDocumentPage":true|false|null,"sameTransaction":true|false|null,"readable":true|false,"approvalSafe":true|false,"detectedIssues":["faint|rotated|blurred|cropped|unreadable"],"matchingEvidence":["short visible facts"],"conflictingEvidence":["short visible facts"],"reason":"short user-facing explanation"}.',
      },
      { role: "user", content },
    ],
    { operation: "document-page-replacement-review" },
  );
  return evaluateDocumentPageReplacementReview(rawReview);
}

async function embedReplacementImage(
  pdf: PDFDocument,
  bytes: Uint8Array,
): Promise<PDFImage> {
  const png = await sharp(Buffer.from(bytes), { failOn: "none" })
    .rotate()
    .png()
    .toBuffer();
  return pdf.embedPng(png);
}

export async function buildReplacedPacketFile(params: {
  originalBytes: Uint8Array;
  originalName: string;
  originalMimeType: string;
  replacementBytes: Uint8Array;
  replacementMimeType: string;
  pageNumber: number;
}) {
  if (params.originalMimeType !== "application/pdf") {
    if (params.pageNumber !== 1) {
      throw new Error("The affected image does not contain that page.");
    }
    if (params.replacementMimeType === "application/pdf") {
      const replacementPdf = await PDFDocument.load(params.replacementBytes, {
        updateMetadata: false,
      });
      if (replacementPdf.getPageCount() !== 1) {
        throw new Error(
          "Choose one image or a one-page PDF as the replacement.",
        );
      }
      return {
        bytes: new Uint8Array(await replacementPdf.save()),
        mimeType: "application/pdf",
        fileName: params.originalName,
        pageCount: 1,
      };
    }
    const outputMime =
      params.replacementMimeType === "image/png" ? "image/png" : "image/jpeg";
    const image = sharp(Buffer.from(params.replacementBytes), {
      failOn: "none",
    }).rotate();
    const bytes =
      outputMime === "image/png"
        ? await image.png().toBuffer()
        : await image.jpeg({ quality: 92 }).toBuffer();
    return {
      bytes: new Uint8Array(bytes),
      mimeType: outputMime,
      fileName: params.originalName,
      pageCount: 1,
    };
  }

  const originalPdf = await PDFDocument.load(params.originalBytes, {
    updateMetadata: false,
  });
  const pageCount = originalPdf.getPageCount();
  if (params.pageNumber < 1 || params.pageNumber > pageCount) {
    throw new Error("The affected page is outside the stored PDF.");
  }
  const pageIndex = params.pageNumber - 1;

  if (params.replacementMimeType === "application/pdf") {
    const replacementPdf = await PDFDocument.load(params.replacementBytes, {
      updateMetadata: false,
    });
    if (replacementPdf.getPageCount() !== 1) {
      throw new Error("Choose one image or a one-page PDF as the replacement.");
    }
    const [replacementPage] = await originalPdf.copyPages(replacementPdf, [0]);
    originalPdf.removePage(pageIndex);
    originalPdf.insertPage(pageIndex, replacementPage);
  } else {
    const oldPage = originalPdf.getPage(pageIndex);
    const { width, height } = oldPage.getSize();
    const replacementImage = await embedReplacementImage(
      originalPdf,
      params.replacementBytes,
    );
    const scale = Math.min(
      width / replacementImage.width,
      height / replacementImage.height,
    );
    const drawnWidth = replacementImage.width * scale;
    const drawnHeight = replacementImage.height * scale;
    originalPdf.removePage(pageIndex);
    const page = originalPdf.insertPage(pageIndex, [width, height]);
    page.drawImage(replacementImage, {
      x: (width - drawnWidth) / 2,
      y: (height - drawnHeight) / 2,
      width: drawnWidth,
      height: drawnHeight,
    });
  }

  return {
    bytes: new Uint8Array(await originalPdf.save()),
    mimeType: "application/pdf",
    fileName: params.originalName,
    pageCount,
  };
}

export function toCurrentCaseDocument(row: Record<string, unknown>): CaseDoc {
  const extractedFields = record(row.extracted_fields);
  const storedLineItems = Array.isArray(extractedFields.__lineItems)
    ? (extractedFields.__lineItems as CaseDoc["lineItems"])
    : undefined;
  const fields = { ...extractedFields };
  delete fields.__lineItems;
  return {
    id: String(row.client_document_id || row.id),
    type: row.document_type as CaseDoc["type"],
    title: String(row.title || row.document_type || "Document"),
    pages: Math.max(1, Number(row.page_count) || 1),
    fields: fields as CaseDoc["fields"],
    lineItems: storedLineItems,
    qualityIssues: Array.isArray(row.quality_issues)
      ? (row.quality_issues as ExtractionQualityIssue[])
      : undefined,
    md: typeof row.markdown === "string" ? row.markdown : "",
    sourceFileName: stringValue(row.source_file_name) || undefined,
    sourceHint: stringValue(row.source_hint) || undefined,
  };
}
