import assert from "node:assert/strict";
import { test } from "node:test";
import { compactReviewProviderSchema } from "../src/server/processing/review-response-schema";

test("large support checklists use typed dictionaries in provider grammar without changing application coverage", () => {
  const generatedFields = Object.fromEntries(
    Array.from({ length: 160 }, (_, index) => [
      `field${index}`,
      { type: "string", enum: ["supported", "unsupported"] },
    ]),
  );
  const map = {
    type: "object",
    properties: generatedFields,
    required: Object.keys(generatedFields),
    additionalProperties: false,
  };
  const original = {
    type: "object",
    properties: { fieldSupport: map, lineItemPropertySupport: map },
    required: ["fieldSupport", "lineItemPropertySupport"],
  };
  const compact = compactReviewProviderSchema(original, []);
  assert.deepEqual(compact.properties, {
    fieldSupport: {
      type: "object",
      additionalProperties: {
        type: "string",
        enum: ["supported", "unsupported"],
      },
    },
    lineItemPropertySupport: {
      type: "object",
      additionalProperties: {
        type: "string",
        enum: ["supported", "unsupported"],
      },
    },
  });
  assert.equal(original.properties.fieldSupport.required.length, 160);
});

test("provider schema keeps the review contract without unsupported or expansive grammar constraints", () => {
  const fields = ["invoiceNumber", "referencePoNumber"];
  const original = {
    type: "object",
    required: ["documentAudits", "verdict"],
    additionalProperties: false,
    properties: {
      verdict: { type: "string", enum: ["pass", "needs_review"] },
      documentAudits: {
        type: "array",
        minItems: 6,
        maxItems: 6,
        uniqueItems: true,
        items: {
          type: "object",
          required: ["docId", "supportedFields"],
          properties: {
            docId: { type: "string", maxLength: 120 },
            supportedFields: {
              type: "array",
              items: { type: "string", enum: fields },
            },
          },
        },
      },
    },
  };
  const compact = compactReviewProviderSchema(original, fields);
  assert.deepEqual(compact, {
    type: "object",
    required: ["documentAudits", "verdict"],
    additionalProperties: false,
    properties: {
      verdict: { type: "string", enum: ["pass", "needs_review"] },
      documentAudits: {
        type: "array",
        items: {
          type: "object",
          required: ["docId", "supportedFields"],
          properties: {
            docId: { type: "string" },
            supportedFields: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  });
  assert.equal(original.properties.documentAudits.minItems, 6);
  assert.equal(
    original.properties.documentAudits.items.properties.docId.maxLength,
    120,
  );
});

test("reference discovery uses one small typed dictionary without expanding every original reference in provider grammar", () => {
  const proof = {
    type: "object",
    properties: {
      value: { type: ["string", "null"] },
      quote: { type: "string" },
    },
    required: ["value", "quote"],
    additionalProperties: false,
  };
  const originals = Array.from({ length: 80 }, (_, i) => `reference${i}`);
  const referenceSchema = {
    type: "object",
    properties: Object.fromEntries(originals.map((key) => [key, proof])),
    required: originals,
    additionalProperties: proof,
  };
  const compact = compactReviewProviderSchema(
    {
      type: "object",
      properties: { references: referenceSchema },
      required: ["references"],
    },
    [],
  );
  assert.deepEqual(compact, {
    type: "object",
    properties: { references: { type: "object", additionalProperties: proof } },
    required: ["references"],
  });
  // The server contract still requires explicit readings of every original.
  assert.equal(referenceSchema.required.length, 80);
  assert.ok(
    JSON.stringify(compact).length <
      JSON.stringify(referenceSchema).length / 10,
  );
});
