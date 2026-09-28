// Provider compatibility check: artificial data only, no case or document reads.
import { existsSync } from "node:fs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const { buildAuthoritativeReviewResponseSchema } =
  await import("../src/server/processing/pipeline");
const { callExtractionReviewModel } =
  await import("../src/server/processing/openrouter");
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (!response.ok) {
    const errorBody = await response
      .clone()
      .json()
      .catch(() => ({}));
    console.error(
      JSON.stringify({
        scope: "artificial-provider-schema-error",
        provider: errorBody.error?.metadata?.provider_name,
        detail: errorBody.error?.metadata?.raw,
      }),
    );
  }
  return response;
};

const startedAt = Date.now();
const simple = process.argv.includes("--simple");
const schema = simple
  ? {
      type: "object",
      properties: { verified: { type: "boolean" } },
      required: ["verified"],
      additionalProperties: false,
    }
  : buildAuthoritativeReviewResponseSchema({
      documentCount: 1,
      mismatchCount: 0,
      pageCount: 1,
    });
function withoutArrayBounds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutArrayBounds);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "minItems" && key !== "maxItems")
      .map(([key, entry]) => [key, withoutArrayBounds(entry)]),
  );
}
const response = await callExtractionReviewModel(
  [
    {
      role: "system",
      content:
        "Return only the requested valid JSON. This is a provider-format check using completely artificial data, not a real procurement review.",
    },
    {
      role: "user",
      content: JSON.stringify({
        fixture: {
          docId: "example-invoice",
          invoiceNumber: "EXAMPLE-001",
          sourceFileName: "artificial.pdf",
          pageNumber: 1,
        },
        instruction:
          "Return verdict pass; empty corrections, reviewIssues, mismatchDecisions, termsChecklist and notes. Include one verified documentAudit with docId example-invoice, supportedFields [invoiceNumber], all other lists empty. Include one packetGroup with this document, relationship standard, primaryDocumentIds and contextDocumentIds empty, caseSummary counterpartyName Example Steel, invoiceNumber EXAMPLE-001, primaryReference EXAMPLE-001, packetCategory Procurement packet and poNumber empty. Include one pageQuality for artificial.pdf page 1, documentId example-invoice, no issues, approvalSafe true, confidence high. Reasons must be brief.",
      }),
    },
  ],
  {
    operation: "artificial-review-contract-check",
    responseSchema: {
      name: "samrat_authoritative_review",
      strict: true,
      schema: process.argv.includes("--no-array-bounds")
        ? (withoutArrayBounds(schema) as Record<string, unknown>)
        : schema,
    },
  },
);
const parsed = JSON.parse(response);
const required = [
  "verdict",
  "corrections",
  "reviewIssues",
  "documentAudits",
  "mismatchDecisions",
  "termsChecklist",
  "packetGroups",
  "pageQuality",
  "notes",
];
if (!simple && !required.every((key) => Object.hasOwn(parsed, key)))
  throw new Error("Incomplete artificial response contract");
console.log(
  JSON.stringify({
    scope: "artificial-review-contract-check",
    providerAcceptedSchema: true,
    durationMs: Date.now() - startedAt,
    persisted: false,
    realDocumentsSent: false,
  }),
);
