import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { buildSync } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const outputDir = resolve("tmp/eway-validity-ui-test");
mkdirSync(outputDir, { recursive: true });
buildSync({
  entryPoints: ["src/components/cases/EWayBillValidityCard.tsx"],
  outdir: outputDir,
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  external: ["react", "react-dom"],
});
const { EWayBillValidityCard } = createRequire(resolve("package.json"))(
  resolve(outputDir, "EWayBillValidityCard.js"),
);
const render = (
  printedValidity: string,
  now = new Date("2026-10-07T07:00:00Z"),
) =>
  renderToStaticMarkup(
    createElement(EWayBillValidityCard, {
      printedValidity,
      billNumber: "411738053196",
      now,
    }),
  );

test("expiry display shows bill number and readable dates without technical explanation", () => {
  const html = render("26.06.2026 23:59:00");
  assert.ok(html.includes("E-Way Bill 411738053196"));
  assert.ok(html.includes("Expired"));
  assert.ok(html.includes("26 Jun 2026"));
  assert.ok(html.includes("7 Oct 2026"));
  assert.ok(html.includes("Today (India)"));
  assert.ok(html.includes("accept or reject"));
  assert.ok(!html.includes("2026-06-26"));
});

test("unreadable dates are not labelled expired", () => {
  for (const value of ["", "unreadable", "31/02/2026"]) {
    const html = render(value);
    assert.ok(html.includes("Unable to check"));
    assert.ok(!html.includes(">Expired<"));
  }
});

test("expiry today stays valid and uses the India calendar date", () => {
  const html = render("07/10/2026", new Date("2026-10-06T20:00:00Z"));
  assert.ok(html.includes(">Valid<"));
  assert.ok(html.includes("7 Oct 2026"));
  assert.ok(!html.includes(">Expired<"));
});
