import type { ReviewSourcePage } from "./pipeline";
import {
  getExtractionReviewModel,
  getExtractionReviewReasoning,
  serializeOpenRouterRequest,
  type OpenRouterMessage,
} from "./openrouter";
import { packRequestBatches, requestByteLimit } from "./request-budget";

export type EvidencePage = ReviewSourcePage & { pointer: string };
export type PageEvidence = {
  pointer: string;
  evidence: string;
  readable: boolean;
};
export const PAGE_EVIDENCE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pointer: { type: "string" },
          evidence: { type: "string", minLength: 1, maxLength: 24000 },
          readable: { type: "boolean" },
        },
        required: ["pointer", "evidence", "readable"],
        additionalProperties: false,
      },
    },
  },
  required: ["pages"],
  additionalProperties: false,
};

export function reviewRequestBody(
  messages: OpenRouterMessage[],
  schema: Record<string, unknown>,
  maxTokens: number,
) {
  return serializeOpenRouterRequest(messages, {
    model: getExtractionReviewModel(),
    reasoning: getExtractionReviewReasoning(),
    maxTokens,
    responseSchema: { name: "bounded_packet_review", strict: true, schema },
  });
}

export function pageEvidenceMessages(
  pages: EvidencePage[],
): OpenRouterMessage[] {
  return [
    {
      role: "system",
      content:
        "Read ONLY the supplied original pages. Return one entry for EVERY page pointer. Transcribe exact printed business evidence: party names and their roles, all references and their labels, dates, every goods/service row with codes, descriptions, quantities, units, rates and amounts, weights, vehicle/transport details, totals/taxes, terms, signatures and document relationships. Keep label and value together. Do not normalize, infer, substitute a filename, summarize away different values, or invent missing information. Retain page provenance. readable=false requires an explanation of what cannot be read; never invent a value. This is a source evidence ledger, not a mismatch decision.",
    },
    {
      role: "user",
      content: pages.flatMap((page) => [
        { type: "text" as const, text: `Page pointer ${page.pointer}` },
        { type: "image_url" as const, image_url: { url: page.image } },
      ]),
    },
  ];
}

export function packetEvidenceBatches(pages: ReviewSourcePage[]) {
  const addressed = pages.map((page, index) => ({
    ...page,
    pointer: `p${index + 1}`,
  }));
  return packRequestBatches(
    addressed,
    (batch) =>
      reviewRequestBody(
        pageEvidenceMessages(batch),
        PAGE_EVIDENCE_SCHEMA,
        16384,
      ),
    Math.floor(requestByteLimit() / 2),
    4,
  );
}

export function validatePageEvidence(
  raw: string,
  pages: EvidencePage[],
): PageEvidence[] {
  const parsed = JSON.parse(raw);
  if (
    !parsed ||
    Object.keys(parsed).length !== 1 ||
    !Array.isArray(parsed.pages) ||
    parsed.pages.length !== pages.length
  )
    throw new Error("Page evidence did not cover every supplied page.");
  const byPointer = new Map<string, PageEvidence>();
  for (const value of parsed.pages) {
    if (
      !value ||
      Object.keys(value).length !== 3 ||
      !pages.some((page) => page.pointer === value.pointer) ||
      byPointer.has(value.pointer) ||
      typeof value.evidence !== "string" ||
      !value.evidence.trim() ||
      value.evidence.length > 24000 ||
      typeof value.readable !== "boolean"
    )
      throw new Error("Invalid or duplicate page evidence.");
    byPointer.set(value.pointer, value);
  }
  return pages.map((page) => byPointer.get(page.pointer)!);
}
