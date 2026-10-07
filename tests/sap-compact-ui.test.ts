import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { buildSync } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { matchFixture } from "./sap-posted-fixture";

const outputDir = resolve("tmp/compact-ui-test");
mkdirSync(outputDir, { recursive: true });
buildSync({
  entryPoints: [
    "src/components/cases/sap-match/MatchingEvidence.tsx",
    "src/components/cases/sap-match/WhatGoesToSap.tsx",
    "src/components/cases/sap-match/CheckBlock.tsx",
    "src/components/cases/sap-match/MatchLineCard.tsx",
  ],
  outdir: outputDir,
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  external: ["react", "react-dom"],
});
const requireComponent = createRequire(resolve("package.json"));
const { MatchingEvidence } = requireComponent(
  resolve(outputDir, "MatchingEvidence.js"),
);
const { WhatGoesToSap } = requireComponent(
  resolve(outputDir, "WhatGoesToSap.js"),
);
const { CheckBlock } = requireComponent(resolve(outputDir, "CheckBlock.js"));
const { MatchLineCard } = requireComponent(
  resolve(outputDir, "MatchLineCard.js"),
);

test("hidden field headers have a positioned cell on both responsive layouts", () => {
  const html = renderToStaticMarkup(
    createElement(MatchLineCard, {
      caseId: "layout-test",
      invoice: matchFixture.invoice,
      line: matchFixture.result.lines[0],
      checks: [],
      locked: true,
      busy: false,
      vendorFound: true,
      onChoose: () => {},
      onUndo: () => {},
      onAllocate: () => {},
      onResetAllocation: () => {},
      onLink: () => {},
    }),
  );
  assert.ok(
    html.includes(
      '<th scope="col" class="relative w-[22%] pb-2 font-medium"><span class="sr-only">Field</span>',
    ),
  );
  assert.ok(
    html.includes(
      '<th scope="col" class="relative w-20 pb-1 font-semibold"><span class="sr-only">Field</span>',
    ),
  );
});

test("one-choice quantity review uses a named action and keeps the remaining balance visible", () => {
  const html = renderToStaticMarkup(
    createElement(CheckBlock, {
      check: {
        id: "qty-0",
        lineIndex: 0,
        sev: "ack",
        open: true,
        ask: "Confirm partial GRPO invoicing?",
        title: "Billed 41.8 of 50",
        help: "The other 8.2 stays open on GRPO 101005.",
        options: [
          {
            choice: "part",
            title: "Confirm partial invoicing",
            lines: ["Bill 41.8 now", "8.2 waits for the next invoice"],
            effect: "resolve",
            recommended: true,
          },
        ],
      },
      locked: false,
      busy: false,
      onChoose: () => {},
      onUndo: () => {},
    }),
  );
  assert.match(html, /other 8.2 stays open/);
  assert.match(html, /<button[^>]*>Confirm partial invoicing<\/button>/);
  assert.doesNotMatch(html, /Choose this|Recommended|Billed 41.8 of 50/);
  assert.match(html, /Decision details/);
  assert.match(html, /8.2 waits for the next invoice/);
});

test("reference exceptions stay visible while the full matching trail is collapsed", () => {
  const invoice = {
    ...matchFixture.invoice,
    poReferences: ["274", "UNLINKED-PO"],
    lorryReceipt: "LR42",
  };
  const line = {
    ...matchFixture.result.lines[0],
    candidates: matchFixture.result.lines[0].candidates.map((candidate) => ({
      ...candidate,
      references: { ...candidate.references!, lorryReceipt: "0" },
    })),
  };
  const html = renderToStaticMarkup(
    createElement(MatchingEvidence, { invoice, line, locked: false }),
  );
  const visibleNotice = html.slice(0, html.indexOf("<details"));
  assert.match(visibleNotice, /UNLINKED-PO/);
  assert.match(visibleNotice, /LR42.*not verified.*SAP stores 0/);
  assert.match(
    html,
    /<details[^>]*><summary[^>]*>Matching evidence<\/summary>/,
  );
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:[ =>])/);
  assert.match(html, /GRPO Quantity received/);
  assert.match(html, /GRPO 718, line 1.*PO 274, line 1/);
});

test("missing historical reference evidence is summarized once without hiding a known vehicle conflict", () => {
  const original = matchFixture.result.lines[0];
  const line = {
    ...original,
    candidates: original.candidates.map((candidate) => ({
      ...candidate,
      references: undefined,
      vehicle: "OTHER",
    })),
  };
  const html = renderToStaticMarkup(
    createElement(MatchingEvidence, {
      invoice: matchFixture.invoice,
      line,
      locked: true,
    }),
  );
  const visibleNotice = html.slice(0, html.indexOf("<details"));
  assert.equal(
    (visibleNotice.match(/reference values were not recorded/g) ?? []).length,
    1,
  );
  assert.match(visibleNotice, /Vehicle No\..*TRUCK1.*OTHER/);
  assert.match(html, /Open at saved check/);
});

test("draft total and action precede collapsed posting details", () => {
  const html = renderToStaticMarkup(
    createElement(WhatGoesToSap, {
      result: matchFixture.result,
      lines: matchFixture.result.lines,
      vendorLabel: "Tata Steel (TSPL001)",
      actions: createElement("button", null, "Create draft"),
    }),
  );
  const summary = html.slice(0, html.indexOf("<details"));
  assert.match(summary, /Draft total.*₹200/);
  assert.match(summary, /Create draft/);
  assert.doesNotMatch(summary, /4130067129|TSPL001|Base Document/);
  assert.match(html, /View draft posting details/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:[ =>])/);
  assert.match(html, /GRPO.*718/);
});
