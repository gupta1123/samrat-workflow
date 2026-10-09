import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { buildSync } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { postedSapDetails } from "../src/lib/sap-posted-details";
import { postedFixture } from "./sap-posted-fixture";

// Next compiles JSX automatically; mirror that transform for node's SSR test.
const output = resolve("tmp/posted-ui-test.cjs");
mkdirSync(resolve("tmp"), { recursive: true });
buildSync({
  entryPoints: ["src/components/cases/sap-match/PostedInvoice.tsx"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  external: ["react", "react-dom", "next"],
});
const { PostedInvoice } = createRequire(resolve("package.json"))(output);

test("posted UI keeps comparison and preview but exposes no financial or match-editing actions", () => {
  const details = postedSapDetails(
    postedFixture,
    [{ action: "sap_ap_invoice_posted", created_at: "2026-10-01" }],
    "next-case",
  );
  const html = renderToStaticMarkup(
    createElement(PostedInvoice, {
      caseId: "case-id",
      documentNumber: "848",
      environment: "test",
      details,
    }),
  );
  for (const text of [
    "Posted as A/P Invoice 848",
    "Comparison saved before posting",
    "Purchase Order",
    "GRPO",
    "Vendor Invoice",
    "Received, not yet billed",
    "GRPO Quantity received",
    "Open at saved check",
    "Used in draft",
    "Posting Date",
    "Document Date",
    "Vendor Ref. No.",
    "Posted invoice details",
    "Saved A/P Invoice Draft Preview",
    "View source documents",
  ])
    assert.ok(html.includes(text), text);
  for (const text of [
    "Re-check",
    "Confirm final posting",
    "Create A/P Invoice Draft",
    "Apply selection",
    "Nothing is created until",
  ])
    assert.ok(!html.includes(text), text);
  assert.ok(!html.includes("Not yet"));
  assert.ok(html.includes('href="/cases/next-case/mismatches?tab=sap"'));
  assert.ok(html.includes("A/P Invoice posted in SAP"));
});
test("older posted UI shows saved references and an honest explanation rather than a new failed match", () => {
  const details = postedSapDetails({
    ...postedFixture,
    payload: { ...postedFixture.payload, matchSnapshot: undefined },
    response: { CardCode: "TSPL001" },
  });
  const html = renderToStaticMarkup(
    createElement(PostedInvoice, {
      caseId: "case-id",
      documentNumber: "848",
      environment: "test",
      details,
    }),
  );
  assert.ok(html.includes("GRPO 718"));
  assert.ok(html.includes("original match comparison was not saved"));
  assert.ok(!html.includes("truck not received"));
  assert.ok(!html.includes("₹236"));
});
