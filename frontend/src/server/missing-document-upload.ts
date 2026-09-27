import { CORE_PACKET_GROUPS } from "@/server/document-schema";
import type { CaseDoc } from "@/types/pipeline";

import {
  callExtractionReviewModel,
  type OpenRouterMessage,
} from "./processing/openrouter";

export type MissingDocumentCandidate = {
  sourceFileName: string;
  documents: CaseDoc[];
  pageImages: string[];
};

export type MissingDocumentFileDecision = {
  sourceFileName: string;
  decision: "accepted" | "rejected" | "needs_review";
  reason: string;
  detectedDocumentTypes: string[];
  satisfiedMissingGroups: string[];
  sameTransaction: boolean | null;
  confidence: "high" | "medium" | "low";
  createNewCaseSuggested: boolean;
};

type RawFileReview = {
  sourceFileName?: unknown;
  verdict?: unknown;
  confidence?: unknown;
  sameTransaction?: unknown;
  detectedDocumentTypes?: unknown;
  satisfiedMissingGroups?: unknown;
  transactionEvidence?: unknown;
  reason?: unknown;
};

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readStrings(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map(readString).filter((entry) => entry.length > 0)),
  );
}

function parseReview(raw: string): RawFileReview[] {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const json = start >= 0 && end > start ? trimmed.slice(start, end + 1) : "";
  if (!json) throw new Error("The document reviewer returned no decision.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("The document reviewer returned an invalid decision.");
  }

  const files = readRecord(parsed).files;
  if (!Array.isArray(files)) {
    throw new Error(
      "The document reviewer did not evaluate the selected files.",
    );
  }
  return files.map((entry) => readRecord(entry) as RawFileReview);
}

function coveredMissingGroups(
  documentTypes: string[],
  missingGroups: string[],
) {
  const missing = new Set(missingGroups);
  const types = new Set(documentTypes);
  return CORE_PACKET_GROUPS.filter(
    (group) =>
      missing.has(group.label) &&
      group.types.some((documentType) => types.has(documentType)),
  ).map((group) => group.label);
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

export function evaluateMissingDocumentUploadReview(params: {
  rawReview: string;
  candidates: MissingDocumentCandidate[];
  missingGroups: string[];
}): MissingDocumentFileDecision[] {
  const reviews = parseReview(params.rawReview);

  return params.candidates.map((candidate) => {
    const review = reviews.find(
      (entry) => readString(entry.sourceFileName) === candidate.sourceFileName,
    );
    if (!review) {
      return {
        sourceFileName: candidate.sourceFileName,
        decision: "needs_review",
        reason:
          "The reviewer could not return a reliable decision for this file, so it was not added.",
        detectedDocumentTypes: [],
        satisfiedMissingGroups: [],
        sameTransaction: null,
        confidence: "low",
        createNewCaseSuggested: false,
      };
    }

    const detectedDocumentTypes = readStrings(review.detectedDocumentTypes);
    const satisfiedMissingGroups = coveredMissingGroups(
      detectedDocumentTypes,
      params.missingGroups,
    );
    const verdict = readString(review.verdict).toLowerCase();
    const confidenceValue = readString(review.confidence).toLowerCase();
    const confidence: MissingDocumentFileDecision["confidence"] =
      confidenceValue === "high" || confidenceValue === "medium"
        ? confidenceValue
        : "low";
    const sameTransaction =
      review.sameTransaction === true
        ? true
        : review.sameTransaction === false
          ? false
          : null;
    const reason =
      readString(review.reason).slice(0, 700) ||
      "The selected file could not be verified against this case.";

    if (
      verdict === "accept" &&
      confidence === "high" &&
      sameTransaction === true &&
      satisfiedMissingGroups.length > 0
    ) {
      return {
        sourceFileName: candidate.sourceFileName,
        decision: "accepted",
        reason,
        detectedDocumentTypes,
        satisfiedMissingGroups,
        sameTransaction,
        confidence,
        createNewCaseSuggested: false,
      };
    }

    const explicitlyUnrelated = sameTransaction === false;
    const noRequiredType = satisfiedMissingGroups.length === 0;
    const rejected =
      verdict === "reject" || explicitlyUnrelated || noRequiredType;
    return {
      sourceFileName: candidate.sourceFileName,
      decision: rejected ? "rejected" : "needs_review",
      reason:
        noRequiredType && !readString(review.reason)
          ? `This file does not contain any of the missing document types: ${params.missingGroups.join(", ")}. It was not added.`
          : reason,
      detectedDocumentTypes,
      satisfiedMissingGroups,
      sameTransaction,
      confidence,
      createNewCaseSuggested: explicitlyUnrelated,
    };
  });
}

export async function reviewMissingDocumentUploads(params: {
  currentDocuments: CaseDoc[];
  candidates: MissingDocumentCandidate[];
  missingGroups: string[];
}) {
  const candidateSummary = params.candidates.map((candidate) => ({
    sourceFileName: candidate.sourceFileName,
    preliminaryDocuments: candidate.documents.map(conciseDocument),
  }));
  const content: Extract<OpenRouterMessage["content"], Array<unknown>> = [
    {
      type: "text",
      text:
        `Missing groups in the current case: ${JSON.stringify(params.missingGroups)}\n\n` +
        `Current analyzed case documents:\n${JSON.stringify(params.currentDocuments.map(conciseDocument))}\n\n` +
        `Selected candidate files and preliminary extraction:\n${JSON.stringify(candidateSummary)}\n\n` +
        "Inspect the supplied candidate page images as the primary evidence. The filename is only an identifier and is never evidence.",
    },
  ];

  for (const candidate of params.candidates) {
    candidate.pageImages.forEach((image, index) => {
      content.push({
        type: "text",
        text: `Candidate file ${JSON.stringify(candidate.sourceFileName)}, visible page ${index + 1}:`,
      });
      content.push({ type: "image_url", image_url: { url: image } });
    });
  }

  const rawReview = await callExtractionReviewModel([
    {
      role: "system",
      content:
        'You are the final admission gate for documents uploaded to resolve missing-document issues in a procurement case. Independently inspect every visible page and compare its printed transaction evidence with the already analyzed case. Do not infer document type, transaction identity, or relevance from a filename. Evaluate each physical file separately. Accept a file only when every procurement document in that file belongs to the same transaction as the current case, at least one document truly satisfies a currently missing group, and the evidence supports this with high confidence. A matching company alone is insufficient. Use transaction references such as PO/invoice/e-way-bill/LR/weighment numbers, counterparties and GSTINs, vehicle, material, quantity/weight, amount, and dates together. Reject files from another transaction, files with no missing document type, and mixed files containing unrelated transactions. Use uncertain when the needed type may be present but transaction linkage or readability is not strong enough. Never guess. Return only JSON with this exact shape: {"files":[{"sourceFileName":"exact supplied identifier","verdict":"accept|reject|uncertain","confidence":"high|medium|low","sameTransaction":true|false|null,"detectedDocumentTypes":["exact document type labels"],"satisfiedMissingGroups":["exact missing group labels"],"transactionEvidence":["short visible facts"],"reason":"short user-facing explanation"}]}. Include exactly one result for every supplied candidate file.',
    },
    { role: "user", content },
  ]);

  return evaluateMissingDocumentUploadReview({
    rawReview,
    candidates: params.candidates,
    missingGroups: params.missingGroups,
  });
}
