import { DOCUMENT_READABILITY_FIELD } from "@/lib/document-readability";
import type { CaseDoc, Mismatch } from "@/types/pipeline";

export type DocumentReadabilitySourcePage = {
  sourceFileName: string;
  pageNumber: number;
};

export type DocumentPageQualityAssessment = {
  sourceFileName: string;
  pageNumber: number;
  documentId: string;
  issues: Array<"faint" | "rotated" | "blurred" | "cropped" | "unreadable">;
  approvalSafe: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
};

const QUALITY_ISSUES = new Set<DocumentPageQualityAssessment["issues"][number]>(
  ["faint", "rotated", "blurred", "cropped", "unreadable"],
);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pageKey(sourceFileName: string, pageNumber: number) {
  return `${sourceFileName}\u0000${pageNumber}`;
}

function readIssues(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) =>
          String(entry ?? "")
            .trim()
            .toLowerCase(),
        )
        .filter(
          (entry): entry is DocumentPageQualityAssessment["issues"][number] =>
            QUALITY_ISSUES.has(
              entry as DocumentPageQualityAssessment["issues"][number],
            ),
        ),
    ),
  );
}

function parseAssessment(
  value: unknown,
  documentsById: Map<string, CaseDoc>,
): DocumentPageQualityAssessment {
  const entry = record(value);
  const sourceFileName =
    typeof entry.sourceFileName === "string" ? entry.sourceFileName.trim() : "";
  const pageNumber = Number(entry.pageNumber);
  const documentId =
    typeof entry.documentId === "string" ? entry.documentId.trim() : "";
  const document = documentsById.get(documentId);
  const confidenceValue = String(entry.confidence ?? "").toLowerCase();
  const confidence = ["high", "medium", "low"].includes(confidenceValue)
    ? (confidenceValue as DocumentPageQualityAssessment["confidence"])
    : null;

  if (
    !sourceFileName ||
    !Number.isSafeInteger(pageNumber) ||
    pageNumber < 1 ||
    !document ||
    document.sourceFileName !== sourceFileName ||
    typeof entry.approvalSafe !== "boolean" ||
    !confidence ||
    typeof entry.reason !== "string" ||
    !entry.reason.trim()
  ) {
    throw new Error(
      "The extraction reviewer returned an incomplete page-quality assessment.",
    );
  }

  const issues = readIssues(entry.issues);
  if (entry.approvalSafe === true && issues.length > 0) {
    throw new Error(
      "The extraction reviewer marked a damaged or rotated page as approval-safe.",
    );
  }
  if (entry.approvalSafe === false && issues.length === 0) {
    throw new Error(
      "The extraction reviewer marked a page unsafe without identifying the reading problem.",
    );
  }

  return {
    sourceFileName,
    pageNumber,
    documentId,
    issues,
    approvalSafe: entry.approvalSafe,
    confidence,
    reason: entry.reason.trim().slice(0, 600),
  };
}

export function parseDocumentPageQuality(params: {
  value: unknown;
  sourcePages: DocumentReadabilitySourcePage[];
  documents: CaseDoc[];
}) {
  if (!params.sourcePages.length) return [];
  if (!Array.isArray(params.value)) {
    throw new Error(
      "The extraction reviewer did not assess the readability of every source page.",
    );
  }

  const documentsById = new Map(
    params.documents.map((document) => [document.id, document]),
  );
  const assessments = params.value.map((entry) =>
    parseAssessment(entry, documentsById),
  );
  const expected = new Set(
    params.sourcePages.map((page) =>
      pageKey(page.sourceFileName, page.pageNumber),
    ),
  );
  const received = new Set<string>();

  for (const assessment of assessments) {
    const key = pageKey(assessment.sourceFileName, assessment.pageNumber);
    if (!expected.has(key) || received.has(key)) {
      throw new Error(
        "The extraction reviewer returned an invalid or duplicate page-quality assessment.",
      );
    }
    received.add(key);
  }
  if (received.size !== expected.size) {
    throw new Error(
      "The extraction reviewer did not assess the readability of every source page.",
    );
  }

  return assessments;
}

function issueLabel(issue: DocumentPageQualityAssessment["issues"][number]) {
  if (issue === "rotated") return "materially rotated";
  if (issue === "cropped") return "cropped";
  return issue;
}

export function buildDocumentReadabilityMismatches(
  assessments: DocumentPageQualityAssessment[],
): Mismatch[] {
  // Only unreadable pages surface as review issues. Lesser quality notes
  // (faint, rotated, blurred, cropped) are intentionally not shown and do
  // not block approval on their own.
  return assessments
    .filter(
      (assessment) =>
        !assessment.approvalSafe && assessment.issues.includes("unreadable"),
    )
    .map((assessment, index) => {
      const issueText = assessment.issues.map(issueLabel).join(", ");
      const location = `${assessment.sourceFileName}, page ${assessment.pageNumber}`;
      return {
        id: `evidence-review-${assessment.documentId}-readability-${assessment.pageNumber}-${index + 1}`,
        field: DOCUMENT_READABILITY_FIELD,
        values: [
          {
            docId: assessment.documentId,
            value: `${location}: ${issueText}`,
            sourceFileName: assessment.sourceFileName,
            pageNumber: assessment.pageNumber,
          },
        ],
        analysis: `The source page is ${issueText} and cannot be trusted for automatic approval. ${assessment.reason}`,
        fixPlan:
          "Upload a clear, upright scan of this page and run the analysis again. Keep the case in review until every critical value is readable.",
      };
    });
}
