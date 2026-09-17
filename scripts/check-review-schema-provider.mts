// Provider grammar smoke test only. No original files or extracted values are
// sent and no case data is changed. The short response is never used as review.
import { existsSync, readFileSync } from "node:fs";
import type { CaseDoc, FieldKey } from "../src/types/pipeline";
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const { buildAuthoritativeReviewResponseSchema } =
  await import("../src/server/processing/pipeline");
const data = JSON.parse(readFileSync(0, "utf8")) as Array<{
  client_document_id: string;
  document_type: string;
  extracted_fields: Record<string, unknown>;
}>;
const documents = data.map((doc) => ({
  id: doc.client_document_id,
  type: doc.document_type,
  title: "Grammar check only",
  pages: 1,
  fields: Object.fromEntries(
    Object.entries(doc.extracted_fields ?? {}).filter(
      ([, value]) => typeof value === "string",
    ),
  ) as Partial<Record<FieldKey, string>>,
  md: "",
})) as CaseDoc[];
const schema = buildAuthoritativeReviewResponseSchema({
  documents,
  documentCount: documents.length,
  mismatchCount: 0,
  pageCount: documents.length,
});
const model =
  process.env.OPENROUTER_REVIEW_MODEL || "~google/gemini-pro-latest";
const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  signal: AbortSignal.timeout(60000),
  headers: {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model,
    messages: [
      {
        role: "user",
        content:
          "Provider grammar check only. There are no source documents to assess. Return the required JSON without inventing review findings.",
      },
    ],
    temperature: 0,
    max_tokens: 64,
    provider: { require_parameters: true },
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "samrat_authoritative_review",
        strict: true,
        schema,
      },
    },
  }),
});
const payload = await response.json();
console.log(
  JSON.stringify({
    scope: "review-schema-provider-check",
    status: response.status,
    documentCount: documents.length,
    schemaBytes: JSON.stringify(schema).length,
    error: payload.error ?? null,
    finishReason: payload.choices?.[0]?.finish_reason ?? null,
    persisted: false,
    sourceValuesSent: false,
  }),
);
