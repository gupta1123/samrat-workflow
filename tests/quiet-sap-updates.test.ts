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
      'export {MatchUpdateContext, MatchUpdateNotice} from "./src/components/cases/sap-match/MatchUpdateContext"; export {ServicePoCandidates} from "./src/components/cases/sap-match/ServicePoCandidates"; export {SapUpdateToast} from "./src/components/cases/sap-match/SapUpdateToast"; export {CaseDecisionActions} from "./src/components/cases/sap-match/CaseDecisionActions";',
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
const {
  MatchUpdateContext,
  MatchUpdateNotice,
  ServicePoCandidates,
  SapUpdateToast,
  CaseDecisionActions,
} = createRequire(resolve("package.json"))(output);
test("inline case approval respects known blockers and disables both decisions while busy", () => {
  const render = (blockedReason: string | null, disabled = false) =>
    renderToStaticMarkup(
      createElement(CaseDecisionActions, {
        caseId: "approval-test",
        blockedReason,
        disabled,
        onDecided: () => {},
      }),
    );
  const blocked = render("Settle the open issues first.");
  assert.ok(blocked.includes("Settle the open issues first."));
  assert.equal(blocked.split('disabled=""').length - 1, 1);
  assert.equal(render(null, true).split('disabled=""').length - 1, 2);
  assert.equal(render(null).split('disabled=""').length - 1, 0);
});
test("SAP progress toast exposes pending and failed checks without claiming premature success", () => {
  const render = (phase: string | null) =>
    renderToStaticMarkup(
      createElement(SapUpdateToast, {
        update: phase ? { action: null, lineIndex: null, phase } : null,
        onRetry: () => {},
      }),
    );
  assert.equal(render(null), "");
  const saving = render("saving");
  assert.ok(saving.includes("Saving your selection"));
  assert.ok(saving.includes('role="status"'));
  const validating = render("validating");
  assert.ok(validating.includes("Checking it against SAP"));
  assert.ok(!validating.includes("SAP check complete"));
  const failed = render("failed");
  assert.ok(failed.includes('role="alert"'));
  assert.ok(failed.includes("last verified comparison"));
  assert.ok(failed.includes("Try again"));
});
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
test("PO table keeps distinct references and item codes distinct without claiming a complete SAP search", () => {
  const line = {
    ...verified.result.lines[0],
    kind: "service",
    index: 0,
    invoiceAmount: 100,
    candidates: [
      {
        key: "88:0",
        docEntry: 88,
        docNum: 475,
        lineNum: 0,
        allocated: 0,
        open: 100,
        good: [],
        bad: [],
        itemCode: "I01",
        references: { po: ["REGION/475"] },
        poEvidence: {},
      },
    ],
  };
  const render = (reference: string) =>
    renderToStaticMarkup(
      createElement(ServicePoCandidates, {
        line,
        invoiceLine: { ...verified.invoice.lines[0], vendorItemCode: "I-01" },
        invoicePoReferences: [reference],
        disabled: false,
        onAllocate: () => {},
        onReset: () => {},
      }),
    );
  const different = render("REGION-475");
  assert.ok(
    different.includes(
      "None of the available PO candidates has that reference",
    ),
  );
  assert.ok(different.includes("Item code differs"));
  assert.ok(!different.includes("SAP has no PO with that number"));
  const exact = render("REGION/475");
  assert.ok(exact.includes("Confirm the correct line before continuing"));
  assert.ok(!exact.includes("more than one line could fit"));
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
