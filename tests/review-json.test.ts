import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DuplicateReviewKeyError,
  parseReviewJson,
} from "../src/server/processing/review-json";

test("review JSON preserves literal values, nested rows and repeated keys in distinct objects", () => {
  const value = {
    references: {
      irnNumber: { value: 'a\\b"c', quote: "IRN:\n[a,b] {value}" },
    },
    rows: [{ value: 1 }, { value: 2 }],
    empty: [],
    none: null,
    flags: [true, false],
  };
  assert.deepEqual(parseReviewJson(` \n${JSON.stringify(value)}\t`), value);
});

test("duplicate review keys cannot silently overwrite conflicting or identical readings", () => {
  for (const raw of [
    '{"references":{"panNumber":{"value":"FIRST"},"panNumber":{"value":"SECOND"}}}',
    '{"references":{"panNumber":null,"panNumber":null}}',
    '{"references":{"panNumber":null,"pan\\u004eumber":null}}',
    '{"references":{},"references":{}}',
    '{"rows":[{"value":1,"value":2}]}',
  ])
    assert.throws(() => parseReviewJson(raw), DuplicateReviewKeyError);
});

test("malformed JSON is rejected before a review can be used", () => {
  for (const raw of ['{"x":', "[1,]", "{x:1}", '{"x":1} trailing'])
    assert.throws(() => parseReviewJson(raw), SyntaxError);
});
