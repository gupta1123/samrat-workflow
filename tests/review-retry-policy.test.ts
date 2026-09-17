import assert from "node:assert/strict";
import { test } from "node:test";
import { isTerminalProcessingError } from "../src/server/process-job";
import { ReviewContractError } from "../src/server/processing/review-contract-error";
import {
  OpenRouterOutputLimitError,
  OpenRouterResponseError,
} from "../src/server/processing/openrouter";

test("exhausted semantic review repair does not re-extract and replay the same packet", () => {
  assert.equal(
    isTerminalProcessingError(
      new OpenRouterResponseError("Provider returned error", 400),
    ),
    true,
  );
  assert.equal(
    isTerminalProcessingError(new OpenRouterResponseError("Retry later", 429)),
    false,
  );
  assert.equal(
    isTerminalProcessingError(
      new OpenRouterOutputLimitError("test-model", 16384),
    ),
    true,
  );
  assert.equal(
    isTerminalProcessingError(
      new ReviewContractError(
        "The reviewer contradicted its own source findings.",
      ),
    ),
    true,
  );
  assert.equal(
    isTerminalProcessingError(
      new Error("Temporary upstream connection closed"),
    ),
    false,
  );
});
