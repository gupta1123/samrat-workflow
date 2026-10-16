import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  retainSapMatchDuringUpdate,
  needsSapMatchPolling,
} from "../src/lib/sap-match-progress";
import type {
  SapMatchAvailable,
  SapMatchResponse,
} from "../src/lib/sap-match-client";
import { matchFixture } from "./sap-posted-fixture";
import {
  DEFAULT_MATCH_RULES,
  EMPTY_MATCH_STATE,
} from "../src/lib/sap-match/types";

const verified: SapMatchAvailable = {
  ...matchFixture,
  available: true,
  sapEnv: "test",
  caseStatus: "accepted",
  postable: true,
  postings: [],
  rules: DEFAULT_MATCH_RULES,
  state: EMPTY_MATCH_STATE,
};
const pending = (
  status: "queued" | "running" | "failed" | "cancelled",
): SapMatchResponse => ({
  available: false,
  sapEnv: "test",
  caseStatus: "accepted",
  postable: true,
  postings: [],
  matchJob: {
    status,
    stage: "Reading SAP",
    error: status === "failed" ? "Read failed" : null,
    attempt: 1,
    requestedAt: "2026-10-16",
    finishedAt: null,
  },
});

test("queued and running updates retain the exact verified comparison, not optimistic totals", () => {
  for (const status of ["queued", "running"] as const) {
    const next = pending(status),
      visible = retainSapMatchDuringUpdate(verified, next);
    assert.equal(visible.available, true);
    if (!visible.available) throw Error("Missing retained comparison");
    assert.equal(visible.result, verified.result);
    assert.equal(visible.invoice, verified.invoice);
    assert.equal(visible.matchJob, next.matchJob);
    assert.equal(needsSapMatchPolling(visible), true);
  }
});
test("failed or cancelled checks retain readable comparison and stop polling", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const visible = retainSapMatchDuringUpdate(verified, pending(status));
    assert.equal(visible.available, true);
    assert.equal(needsSapMatchPolling(visible), false);
  }
});
test("fresh success replaces the old comparison and first loads never invent a comparison", () => {
  const fresh = {
    ...verified,
    result: { ...verified.result, checkedAt: "2026-10-16" },
  };
  assert.equal(retainSapMatchDuringUpdate(verified, fresh), fresh);
  const queued = pending("queued");
  assert.equal(retainSapMatchDuringUpdate(null, queued), queued);
  assert.equal(
    retainSapMatchDuringUpdate(verified, { ...queued, sapEnv: "live" })
      .available,
    false,
  );
  const unavailable = {
    ...queued,
    matchJob: { ...queued.matchJob!, status: "succeeded" as const },
  };
  assert.equal(retainSapMatchDuringUpdate(verified, unavailable), unavailable);
});
test("saved drafts and posted history take precedence over retained edit screens", () => {
  const next = {
    ...pending("running"),
    postings: [
      {
        kind: "AP",
        status: "posted",
        sap_env: "test",
        sap_docnum: "123",
        error: null,
        created_at: "",
        updated_at: "",
      },
    ],
  };
  assert.equal(retainSapMatchDuringUpdate(verified, next), next);
});

mkdirSync(resolve("tmp"), { recursive: true });
const output = resolve("tmp/quiet-sap-ui.cjs");
buildSync({
  stdin: {
    contents:
      'export {MatchUpdateContext, MatchUpdateNotice} from "./src/components/cases/sap-match/MatchUpdateContext"; export {ServicePoCandidates} from "./src/components/cases/sap-match/ServicePoCandidates";',
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  outfile: output,
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  external: ["react", "react-dom"],
});
const { MatchUpdateContext, MatchUpdateNotice, ServicePoCandidates } =
  createRequire(resolve("package.json"))(output);
test("pending PO choice is shown immediately without claiming validated matching or changing totals", () => {
  const line = {
    ...verified.result.lines[0],
    kind: "non-stock",
    index: 0,
    invoiceAmount: 100,
    candidates: [
      {
        key: "4:0",
        docEntry: 4,
        docNum: 44,
        lineNum: 0,
        allocated: 0,
        openQty: 1,
        price: 100,
        qty: 1,
        kind: "PO",
        itemCode: "NS1",
        itemName: "Maintenance",
        good: [],
        bad: [],
        poEvidence: { description: "Maintenance" },
      },
    ],
  };
  const action = {
    action: "allocate",
    lineIndex: 0,
    allocations: { "4:0": 100 },
  };
  const render = (phase: string) =>
    renderToStaticMarkup(
      createElement(
        MatchUpdateContext.Provider,
        { value: { action, lineIndex: 0, phase } },
        createElement(ServicePoCandidates, {
          line,
          disabled: true,
          onAllocate: () => {},
          onReset: () => {},
        }),
      ),
    );
  assert.ok(render("validating").includes('checked=""'));
  assert.ok(!render("failed").includes('checked=""'));
  const notice = renderToStaticMarkup(
    createElement(
      MatchUpdateContext.Provider,
      { value: { action, lineIndex: 0, phase: "validating" } },
      createElement(MatchUpdateNotice, { lineIndex: 0 }),
    ),
  );
  assert.ok(notice.includes("last verified values"));
  assert.ok(notice.includes('role="status"'));
});
test("draft guards and stable loading states are wired into the real panels", () => {
  const sap = readFileSync("src/components/cases/SapMatchPanel.tsx", "utf8");
  assert.ok(sap.includes("retainSapMatchDuringUpdate(previous, response)"));
  assert.ok(sap.includes("if (loading && !data)"));
  assert.ok(sap.includes("version !== requestVersion.current"));
  assert.ok(sap.includes("busy || creating || validationRequired"));
  const list = readFileSync("src/components/cases/CasesPage.tsx", "utf8");
  assert.ok(!list.includes("setCases([])"));
  assert.ok(list.includes("else if (visibleCases.current === null)"));
  const legacy = readFileSync(
    "src/components/cases/SapPostingPanel.tsx",
    "utf8",
  );
  assert.ok(legacy.includes("if (loading && !readiness)"));
  assert.ok(legacy.includes("statusCallback.current"));
  const header = readFileSync(
    "src/components/cases/sap-match/DraftHeaderFields.tsx",
    "utf8",
  );
  assert.ok(header.includes("initializedCase.current !== caseId"));
  assert.ok(header.includes("if (active) setFetching(false)"));
  const receipts = readFileSync(
    "src/components/cases/sap-match/ReceiptCandidatesPanel.tsx",
    "utf8",
  );
  const apply = receipts.slice(
    receipts.indexOf("onAllocate(line.index, selection.allocations)"),
  );
  assert.ok(!apply.slice(0, apply.indexOf("Apply")).includes("setOpen(false)"));
  assert.ok(!apply.slice(0, apply.indexOf("Apply")).includes("setEdits({})"));
});
