import { test } from "node:test";
import assert from "node:assert/strict";
import { isSameOriginRequest } from "../src/server/api/origin";
test("browser writes accept the public host behind an internal Next.js URL", () =>
  assert.equal(
    isSameOriginRequest(
      new Request("http://localhost:3067/api/cases", {
        method: "POST",
        headers: { host: "127.0.0.1:3067", origin: "http://127.0.0.1:3067" },
      }),
    ),
    true,
  ));
test("browser writes from another origin are rejected", () =>
  assert.equal(
    isSameOriginRequest(
      new Request("https://samrat.example/api/cases", {
        method: "POST",
        headers: { host: "samrat.example", origin: "https://attacker.example" },
      }),
    ),
    false,
  ));
test("opaque origins are rejected", () =>
  assert.equal(
    isSameOriginRequest(
      new Request("https://samrat.example/api/cases", {
        method: "POST",
        headers: { origin: "null" },
      }),
    ),
    false,
  ));
