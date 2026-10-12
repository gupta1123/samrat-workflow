import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { buildSync } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { matchFixture } from "./sap-posted-fixture";
import { receiptProblems } from "../src/lib/sap-match/receipt-problems";

const outputDir = resolve("tmp/compact-ui-test");
mkdirSync(outputDir, { recursive: true });
buildSync({
  entryPoints: [
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
const { WhatGoesToSap } = requireComponent(
  resolve(outputDir, "WhatGoesToSap.js"),
);
const { CheckBlock } = requireComponent(resolve(outputDir, "CheckBlock.js"));
const { MatchLineCard } = requireComponent(
  resolve(outputDir, "MatchLineCard.js"),
);

test("the line card uses one comparison table for every screen size", () => {
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
      '<th scope="col" class="w-20 px-3 py-1.5"><span class="sr-only">Field</span>',
    ),
  );
  assert.equal(html.includes("sm:hidden"), false);
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
  assert.match(html, /8.2 waits for the next invoice/);
});

test("receipt reference problems are one short line per receipt in use", () => {
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
  const { rows, missingNote } = receiptProblems(invoice, line);
  assert.equal(missingNote, null);
  assert.ok(rows.some((row) => /GRPO 718: .*lorry receipt.*Blank in SAP/.test(row)), rows.join("|"));
});

test("missing historical reference evidence is summarized once and a known truck conflict stays", () => {
  const original = matchFixture.result.lines[0];
  const line = {
    ...original,
    candidates: original.candidates.map((candidate) => ({
      ...candidate,
      references: undefined,
      vehicle: "OTHER",
    })),
  };
  const { rows, missingNote } = receiptProblems(matchFixture.invoice, line);
  assert.match(missingNote ?? "", /GRPO 718: reference values were not recorded/);
  assert.ok(rows.some((row) => /different truck \(OTHER\)/.test(row)), rows.join("|"));
});

test("draft sheet opens with the invoice layout and ends with the match line and action", () => {
  const html = renderToStaticMarkup(
    createElement(WhatGoesToSap, {
      result: matchFixture.result,
      lines: matchFixture.result.lines,
      vendorLabel: "Tata Steel (TSPL001)",
      actions: createElement("button", null, "Create draft"),
    }),
  );
  assert.match(html, /A\/P Invoice Draft/);
  assert.match(html, /Not created yet/);
  assert.match(html, /TSPL001/);
  assert.match(html, /Base document/);
  assert.match(html, /GRPO.*718/);
  assert.match(html, /Total before tax/);
  assert.match(html, /Added by SAP/);
  const afterSheet = html.slice(html.lastIndexOf("</details>"));
  assert.match(afterSheet, /Matches invoice.*₹200/);
  assert.match(afterSheet, /Create draft/);
});
