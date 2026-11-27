// Provider grammar adaptation only: no document values are read or rewritten.
// Exact audit coverage, allowed keys, and evidence remain application-validated.
export function compactReviewProviderSchema(
  schema: Record<string, unknown>,
  allowedFieldKeys: readonly string[],
): Record<string, unknown> {
  function visit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => {
        // A single typed reference dictionary avoids both competing ledgers
        // and an exponential grammar from expanding every original field next
        // to arbitrary discoveries. Exact keys/coverage remain parser-owned.
        if (
          key === "references" &&
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          typeof (entry as Record<string, unknown>).additionalProperties ===
            "object"
        ) {
          return [
            [
              key,
              {
                type: "object",
                additionalProperties: visit(
                  (entry as Record<string, unknown>).additionalProperties,
                ),
              },
            ],
          ];
        }
        // Expanding hundreds of required field-name properties exceeds the
        // provider's grammar complexity limit on ordinary multi-page packets.
        // Keep its typed verdict dictionary small; the generated checklist in
        // the prompt and the application enforce exact document/field coverage.
        if (
          key === "fieldSupport" ||
          key === "lineItemPropertySupport" ||
          key === "fieldChecks" ||
          key === "lineItemChecks"
        ) {
          return [
            [
              key,
              {
                type: "object",
                additionalProperties: {
                  type: "string",
                  enum: ["supported", "unsupported"],
                },
              },
            ],
          ];
        }
        // Outside Gemini's documented schema subset.
        if (key === "maxLength" || key === "uniqueItems") return [];
        // Exact/large array bounds make Gemini's decoding grammar reject this
        // nested contract. Exact document, candidate, and page coverage is
        // already checked by parseAuthoritativeReviewResult/pageQuality.
        if (key === "minItems" || key === "maxItems") return [];
        // Do not repeatedly expand the full extraction taxonomy in the
        // provider grammar. This allowlist stays in the prompt and parser.
        if (key === "enum" && entry === allowedFieldKeys) return [];
        return [[key, visit(entry)]];
      }),
    );
  }
  return visit(schema) as Record<string, unknown>;
}
