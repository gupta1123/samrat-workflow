import { remainingTimeout } from "./deadline";

const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL ||
  process.env.NEXT_PUBLIC_OPENROUTER_MODEL ||
  "google/gemini-2.5-flash";
const OPENROUTER_QUALITY_MODEL =
  process.env.OPENROUTER_QUALITY_MODEL ||
  process.env.GEMINI_THINKING_MODEL ||
  "google/gemini-2.5-flash";
const OPENROUTER_REVIEW_MODEL =
  process.env.OPENROUTER_REVIEW_MODEL ||
  process.env.OPENROUTER_EXTRACTION_REVIEW_MODEL ||
  "~google/gemini-pro-latest";
const OPENROUTER_REVIEW_REASONING_EFFORT =
  process.env.OPENROUTER_REVIEW_REASONING_EFFORT ||
  process.env.EXTRACTION_REVIEW_REASONING_EFFORT ||
  "medium";
const OPENROUTER_REVIEW_REASONING_TOKENS = Number(
  process.env.OPENROUTER_REVIEW_REASONING_TOKENS ?? 2048,
);
const OPENROUTER_QUALITY_REASONING_TOKENS = Number(
  process.env.OPENROUTER_QUALITY_REASONING_TOKENS ?? 2000,
);
const OPENROUTER_MAX_OUTPUT_TOKENS = Number(
  process.env.OPENROUTER_MAX_OUTPUT_TOKENS ?? 8192,
);
const OPENROUTER_REVIEW_MAX_OUTPUT_TOKENS = Number(
  process.env.OPENROUTER_REVIEW_MAX_OUTPUT_TOKENS ?? 16384,
);
const OPENROUTER_REVIEW_TIMEOUT_MS = Number(
  process.env.OPENROUTER_REVIEW_TIMEOUT_MS ?? 6 * 60_000,
);
const MAX_RETRIES = Number(process.env.OPENROUTER_MAX_RETRIES ?? 2);
const RETRY_BASE_MS = Number(process.env.OPENROUTER_RETRY_BASE_MS ?? 1200);
const OPENROUTER_TIMEOUT_MS = Number(
  process.env.OPENROUTER_TIMEOUT_MS ?? 60_000,
);

export type OpenRouterMessage = {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
};

type OpenRouterContentPart = {
  text?: string;
};

type OpenRouterReasoningOptions = {
  max_tokens?: number;
  effort?: "none" | "low" | "medium" | "high" | "max";
  enabled?: boolean;
  exclude?: boolean;
};

export type OpenRouterResponseSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHardQuotaError(message: string) {
  const lower = message.toLowerCase();
  return (
    lower.includes("limit: 0") ||
    lower.includes("quota exceeded") ||
    lower.includes("billing") ||
    lower.includes("insufficient credits")
  );
}

function isRetryableStatus(status: number) {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function normalizeMaxTokens(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.floor(value);
}

export class OpenRouterOutputLimitError extends Error {
  constructor(model: string, maxTokens?: number) {
    super(
      `OpenRouter response from ${model} reached the configured output limit${maxTokens ? ` (${maxTokens} tokens)` : ""} before it was complete.`,
    );
    this.name = "OpenRouterOutputLimitError";
  }
}

export class OpenRouterResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OpenRouterResponseError";
  }
}

function timeoutMessage(model: string, timeoutMs: number) {
  return `OpenRouter request timed out after ${Math.round(timeoutMs / 1000)}s for model ${model}.`;
}

type ErrorWithCause = Error & {
  cause?: { code?: unknown; message?: unknown } | unknown;
};

function requestExceptionMessage(
  error: unknown,
  model: string,
  timeoutMs: number,
) {
  if (error instanceof Error && error.name === "AbortError") {
    return timeoutMessage(model, timeoutMs);
  }

  if (!(error instanceof Error)) {
    return String(error ?? "Unknown error");
  }

  const cause = (error as ErrorWithCause).cause;
  if (cause && typeof cause === "object") {
    const causeCode = "code" in cause ? String(cause.code || "") : "";
    const causeMessage = "message" in cause ? String(cause.message || "") : "";
    const detail = [causeCode, causeMessage].filter(Boolean).join(": ");
    if (detail)
      return `OpenRouter request could not be sent (${detail.slice(0, 300)}).`;
  }

  return error.message;
}

function isInvalidRequestConstruction(error: unknown) {
  if (!(error instanceof Error)) return false;
  const cause = (error as ErrorWithCause).cause;
  if (!cause || typeof cause !== "object" || !("code" in cause)) return false;
  return String(cause.code) === "UND_ERR_INVALID_ARG";
}

function logOpenRouterDiagnostic(event: Record<string, unknown>) {
  if (process.env.OPENROUTER_DEBUG_LOG !== "true") return;
  console.log(JSON.stringify({ scope: "openrouter", ...event }));
}

function logOpenRouterTiming(event: Record<string, unknown>) {
  if (process.env.PACKET_PERFORMANCE_LOG === "false") return;
  console.info(JSON.stringify({ scope: "packet-ai-timing", ...event }));
}

export async function callOpenRouter(
  messages: OpenRouterMessage[],
  options?: {
    expectJson?: boolean;
    jsonMode?: boolean;
    model?: string;
    reasoning?: OpenRouterReasoningOptions;
    maxTokens?: number;
    timeoutMs?: number;
    operation?: string;
    requireCompleteOutput?: boolean;
    responseSchema?: OpenRouterResponseSchema;
  },
) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }
  if (!/^[\x21-\x7E]+$/.test(OPENROUTER_API_KEY)) {
    throw new Error(
      "OPENROUTER_API_KEY contains a space, line break, or hidden character. Repair the saved OpenRouter key.",
    );
  }

  const maxTokens = normalizeMaxTokens(
    options?.maxTokens ?? OPENROUTER_MAX_OUTPUT_TOKENS,
  );
  const model = options?.model || OPENROUTER_MODEL;
  const timeoutMs =
    Number.isFinite(options?.timeoutMs) && Number(options?.timeoutMs) > 0
      ? Number(options?.timeoutMs)
      : OPENROUTER_TIMEOUT_MS;
  let attempt = 0;
  let lastError = "OpenRouter request failed";

  while (attempt <= MAX_RETRIES) {
    const requestStartedAt = Date.now();
    const abortController = new AbortController();
    const timeoutId = setTimeout(
      () => abortController.abort(),
      remainingTimeout(timeoutMs),
    );
    try {
      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          signal: abortController.signal,
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": process.env.APP_BASE_URL || "http://localhost:3001",
            "X-Title": "Samrat Group Case Review",
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0,
            ...(options?.reasoning ? { reasoning: options.reasoning } : {}),
            ...(options?.responseSchema
              ? {
                  response_format: {
                    type: "json_schema",
                    json_schema: {
                      name: options.responseSchema.name,
                      strict: options.responseSchema.strict ?? false,
                      schema: options.responseSchema.schema,
                    },
                  },
                  // Do not silently route a structured review through an
                  // endpoint that ignores its schema. That would recreate the
                  // expensive format-retry path this contract eliminates.
                  provider: { require_parameters: true },
                }
              : options?.jsonMode || options?.expectJson
                ? { response_format: { type: "json_object" } }
                : {}),
            ...(maxTokens ? { max_tokens: maxTokens } : {}),
          }),
        },
      );
      const payload = await response.json().catch((error) => {
        if (abortController.signal.aborted) throw error;
        return {};
      });
      clearTimeout(timeoutId);
      if (!response.ok || payload?.error) {
        let providerMessage = "";
        try {
          providerMessage = String(
            JSON.parse(payload?.error?.metadata?.raw ?? "{}")?.error?.message ??
              "",
          );
        } catch {
          /* Provider details are optional and never control semantics. */
        }
        const errorText =
          payload?.error?.message ||
          payload?.message ||
          (response.ok
            ? "OpenRouter returned an error payload"
            : `OpenRouter request failed (${response.status})`);
        lastError = providerMessage
          ? `${errorText} (HTTP ${response.status}): ${providerMessage}`
          : errorText;
        logOpenRouterDiagnostic({
          event: "response_error",
          model,
          attempt: attempt + 1,
          status: response.status,
          durationMs: Date.now() - requestStartedAt,
          error: lastError,
          provider: payload?.error?.metadata?.provider_name ?? null,
        });
        logOpenRouterTiming({
          operation: options?.operation ?? "ai-request",
          event: "response_error",
          model,
          attempt: attempt + 1,
          status: response.status,
          durationMs: Date.now() - requestStartedAt,
        });

        if (
          !isRetryableStatus(response.status) ||
          isHardQuotaError(errorText) ||
          attempt === MAX_RETRIES
        ) {
          throw new OpenRouterResponseError(lastError, response.status);
        }

        const delayMs = RETRY_BASE_MS * Math.pow(2, attempt);
        await sleep(delayMs);
        attempt += 1;
        continue;
      }

      const message = payload?.choices?.[0]?.message?.content;
      const content = Array.isArray(message)
        ? message
            .map((part: OpenRouterContentPart) => part?.text || "")
            .join("\n")
        : String(message || "");
      logOpenRouterDiagnostic({
        event: "response_success",
        model,
        attempt: attempt + 1,
        status: response.status,
        durationMs: Date.now() - requestStartedAt,
        finishReason: payload?.choices?.[0]?.finish_reason ?? null,
        usage: payload?.usage ?? null,
        contentLength: content.length,
        content,
      });
      logOpenRouterTiming({
        operation: options?.operation ?? "ai-request",
        event: "response_success",
        model,
        attempt: attempt + 1,
        status: response.status,
        durationMs: Date.now() - requestStartedAt,
        finishReason: payload?.choices?.[0]?.finish_reason ?? null,
        promptTokens: payload?.usage?.prompt_tokens ?? null,
        completionTokens: payload?.usage?.completion_tokens ?? null,
      });
      if (
        options?.requireCompleteOutput &&
        payload?.choices?.[0]?.finish_reason === "length"
      ) {
        throw new OpenRouterOutputLimitError(model, maxTokens);
      }
      return content;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof OpenRouterOutputLimitError) throw error;
      // HTTP response retries are handled above while the response status is
      // still available. Never replay a terminal 4xx, exhausted 5xx, or quota
      // response as if it were a network exception.
      if (error instanceof OpenRouterResponseError) throw error;
      lastError = requestExceptionMessage(error, model, timeoutMs);
      logOpenRouterDiagnostic({
        event: "request_exception",
        model,
        attempt: attempt + 1,
        durationMs: Date.now() - requestStartedAt,
        error: lastError,
      });
      logOpenRouterTiming({
        operation: options?.operation ?? "ai-request",
        event: "request_exception",
        model,
        attempt: attempt + 1,
        durationMs: Date.now() - requestStartedAt,
      });
      if (isInvalidRequestConstruction(error) || attempt === MAX_RETRIES) {
        throw new Error(lastError);
      }
      const delayMs = RETRY_BASE_MS * Math.pow(2, attempt);
      await sleep(delayMs);
      attempt += 1;
    }
  }

  throw new Error(lastError);
}

export function getQualityExtractionModel() {
  return OPENROUTER_QUALITY_MODEL;
}

export function getExtractionReviewModel() {
  return OPENROUTER_REVIEW_MODEL;
}

export function getExtractionReviewProvider() {
  return "openrouter";
}

export function getQualityExtractionReasoning() {
  if (
    !Number.isFinite(OPENROUTER_QUALITY_REASONING_TOKENS) ||
    OPENROUTER_QUALITY_REASONING_TOKENS <= 0
  ) {
    return undefined;
  }

  return {
    max_tokens: OPENROUTER_QUALITY_REASONING_TOKENS,
    exclude: true,
  } satisfies OpenRouterReasoningOptions;
}

export function getExtractionReviewReasoning() {
  const reasoningTokens = normalizeMaxTokens(
    OPENROUTER_REVIEW_REASONING_TOKENS,
  );
  if (reasoningTokens) {
    return {
      max_tokens: reasoningTokens,
      exclude: true,
    } satisfies OpenRouterReasoningOptions;
  }

  if (!["low", "medium", "high"].includes(OPENROUTER_REVIEW_REASONING_EFFORT)) {
    return {
      effort: "medium",
      exclude: true,
    } satisfies OpenRouterReasoningOptions;
  }

  return {
    effort: OPENROUTER_REVIEW_REASONING_EFFORT as "low" | "medium" | "high",
    exclude: true,
  } satisfies OpenRouterReasoningOptions;
}

export function getExtractionReviewReasoningEffort() {
  const reasoning = getExtractionReviewReasoning();
  return reasoning.max_tokens
    ? `${reasoning.max_tokens} tokens`
    : (reasoning.effort ?? "medium");
}

export async function callExtractionReviewModel(
  messages: OpenRouterMessage[],
  options?: {
    operation?: string;
    responseSchema?: OpenRouterResponseSchema;
    maxTokens?: number;
  },
) {
  return callOpenRouter(messages, {
    expectJson: true,
    jsonMode: true,
    model: OPENROUTER_REVIEW_MODEL,
    reasoning: getExtractionReviewReasoning(),
    maxTokens: normalizeMaxTokens(
      options?.maxTokens ?? OPENROUTER_REVIEW_MAX_OUTPUT_TOKENS,
    ),
    timeoutMs: OPENROUTER_REVIEW_TIMEOUT_MS,
    operation: options?.operation ?? "extraction-review",
    requireCompleteOutput: true,
    responseSchema: options?.responseSchema,
  });
}
