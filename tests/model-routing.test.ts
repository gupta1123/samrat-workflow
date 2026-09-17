import assert from "node:assert/strict";
import { test } from "node:test";

test("document extraction uses Flash and the separate final review uses Gemini 3 Pro despite legacy OpenAI settings", async (t) => {
  const settings: Record<string, string | undefined> = {
    OPENROUTER_API_KEY: "test-key-no-network",
    OPENROUTER_MODEL: undefined,
    NEXT_PUBLIC_OPENROUTER_MODEL: undefined,
    OPENROUTER_QUALITY_MODEL: undefined,
    GEMINI_THINKING_MODEL: undefined,
    OPENROUTER_REVIEW_MODEL: undefined,
    OPENROUTER_EXTRACTION_REVIEW_MODEL: undefined,
    OPENROUTER_DEBUG_LOG: "false",
    // Old deployment settings must not silently select the removed provider.
    EXTRACTION_REVIEW_PROVIDER: "openai",
    OPENAI_API_KEY: "unused-test-key",
  };
  const previous = Object.fromEntries(
    Object.keys(settings).map((key) => [key, process.env[key]]),
  );
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({
      choices: [{ message: { content: '{"verified":true}' } }],
    });
  });
  const provider = await import("../src/server/processing/openrouter");
  const messages: Parameters<typeof provider.callOpenRouter>[0] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Extract the document fields as JSON." },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,fixture" },
        },
      ],
    },
  ];

  const results = [
    await provider.callOpenRouter(messages, { jsonMode: true }),
    await provider.callOpenRouter(messages, {
      jsonMode: true,
      model: provider.getQualityExtractionModel(),
      reasoning: provider.getQualityExtractionReasoning(),
    }),
    await provider.callExtractionReviewModel(messages, {
      responseSchema: {
        name: "review_result",
        schema: {
          type: "object",
          properties: { verified: { type: "boolean" } },
          required: ["verified"],
          additionalProperties: false,
        },
      },
    }),
  ];

  assert.equal(requests.length, 3);
  for (const request of requests.slice(0, 2)) {
    assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(request.body.model, "google/gemini-2.5-flash");
    assert.deepEqual(request.body.messages, messages);
    assert.deepEqual(request.body.response_format, { type: "json_object" });
  }
  assert.equal(
    requests[2].url,
    "https://openrouter.ai/api/v1/chat/completions",
  );
  assert.equal(requests[2].body.model, "~google/gemini-pro-latest");
  assert.deepEqual(requests[2].body.messages, messages);
  assert.deepEqual(requests[2].body.response_format, {
    type: "json_schema",
    json_schema: {
      name: "review_result",
      strict: false,
      schema: {
        type: "object",
        properties: { verified: { type: "boolean" } },
        required: ["verified"],
        additionalProperties: false,
      },
    },
  });
  assert.deepEqual(requests[2].body.provider, { require_parameters: true });
  assert.deepEqual(requests[2].body.reasoning, {
    max_tokens: 2048,
    exclude: true,
  });
  assert.equal(requests[2].body.max_tokens, 16384);
  for (const result of results) {
    assert.deepEqual(JSON.parse(result), { verified: true });
  }
});

test("final review rejects a response truncated at the output limit without replaying it", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key-no-network";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });

  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({
      choices: [
        {
          finish_reason: "length",
          message: {
            content: '{"verdict":"pass","corrections":[]',
          },
        },
      ],
      usage: { completion_tokens: 16384 },
    });
  });

  const provider = await import("../src/server/processing/openrouter");
  await assert.rejects(
    provider.callExtractionReviewModel([
      { role: "user", content: "Return the final review JSON." },
    ]),
    /reached the configured output limit \(16384 tokens\)/,
  );
  assert.equal(calls, 1);
});

test("a non-retryable OpenRouter response is not replayed as a network error", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json(
      { error: { message: "Invalid structured output schema" } },
      { status: 400 },
    );
  });

  const provider = await import("../src/server/processing/openrouter");
  await assert.rejects(
    provider.callExtractionReviewModel([
      { role: "user", content: "Return the final review JSON." },
    ]),
    /Invalid structured output schema/,
  );
  assert.equal(calls, 1);
});
