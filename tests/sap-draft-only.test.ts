import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildSync } from "esbuild";
import { GET, POST } from "../src/app/api/cases/[id]/sap-ap-draft/post/route";
import { POST as legacyPost } from "../src/app/api/cases/[id]/sap-post/route";

mkdirSync(resolve("tmp"), { recursive: true });
const output = resolve("tmp/sap-draft-only-ui-test.cjs");
buildSync({
  entryPoints: ["src/components/cases/sap-match/FinalPostSection.tsx"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  external: ["react", "react-dom", "next"],
});
const { FinalPostSection } = createRequire(resolve("package.json"))(output);

test("saved draft is a completed, read-only final state without a final-post action", () => {
  const html = renderToStaticMarkup(
    createElement(FinalPostSection, {
      status: "prepared",
      documentNumber: "245388",
    }),
  );
  assert.ok(html.includes("Completed - A/P Invoice Draft saved in SAP Test"));
  assert.ok(html.includes("245388"));
  assert.ok(html.includes("final step in this app"));
  assert.ok(html.includes("No further posting action is required"));
  assert.ok(!html.includes("<button"));
  assert.ok(!html.includes("then post"));
});

test("historical posted invoices stay truthful and read-only rather than becoming drafts", () => {
  const html = renderToStaticMarkup(
    createElement(FinalPostSection, {
      status: "posted",
      documentNumber: "101896",
    }),
  );
  assert.ok(html.includes("previously posted"));
  assert.ok(html.includes("101896"));
  assert.ok(html.includes("historical record is read-only"));
  assert.ok(!html.includes("Draft Entry No."));
  assert.ok(!html.includes("<button"));
});

test("final-post preflight, conversion and legacy direct posting fail closed without network or database access", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw Error("No network call is permitted");
  });
  for (const handler of [GET, POST, legacyPost]) {
    const response = await handler();
    assert.equal(response.status, 410);
    const body = await response.json();
    assert.equal(body.code, "SAP_DRAFT_ONLY");
    assert.equal(body.ok, false);
    assert.ok(body.error.includes("Final A/P Invoice posting is disabled"));
  }
  assert.equal(network.mock.callCount(), 0);
});

test("both draft UIs contain no final-post request, confirmation or next-post instruction", () => {
  for (const path of [
    "src/components/cases/SapMatchPanel.tsx",
    "src/components/cases/SapInvoicePreparePanel.tsx",
    "src/components/cases/sap-match/FinalPostSection.tsx",
  ]) {
    const source = readFileSync(path, "utf8");
    for (const forbidden of [
      "/sap-ap-draft/post",
      "Post A/P Invoice Draft",
      "Confirm final posting",
      "then post it as",
      "before final posting",
    ])
      assert.ok(!source.includes(forbidden), path + ": " + forbidden);
  }
});

test("SAP client retains draft creation but no draft-to-invoice conversion capability", () => {
  const source = readFileSync("src/server/sap/service-layer.ts", "utf8");
  assert.ok(source.includes('request("/Drafts", {'));
  assert.ok(source.includes("async createDraft(payload)"));
  assert.ok(!source.includes("finalizeDraft"));
  assert.ok(!source.includes("DraftsService_SaveDraftToDocument"));
});
