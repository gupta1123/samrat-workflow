import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidateEvidence,
  quantityBalances,
  truthfulChecks,
} from "../src/lib/sap-match/evidence";
import { evaluateMatch } from "../src/lib/sap-match/engine";
import {
  sapMatchPresentation,
  sapMessage,
} from "../src/lib/sap-match/terminology";
import { matchFixture } from "./sap-posted-fixture";
import type { MatchContext } from "../src/lib/sap-match/types";

test("PO reference evidence distinguishes the matched reference from an additional reference", () => {
  const row = candidateEvidence(
    { ...matchFixture.invoice, poReferences: ["274", "9519859812"] },
    matchFixture.result.lines[0].candidates[0],
  )[0];
  assert.equal(row.status, "Partly matched");
  assert.match(row.note!, /9519859812.*not matched/);
});

test("SAP LR zero is shown as unverified rather than a match or conflicting real reference", () => {
  const candidate = matchFixture.result.lines[0].candidates[0];
  const rows = candidateEvidence(
    { ...matchFixture.invoice, lorryReceipt: "LR42" },
    {
      ...candidate,
      references: { ...candidate.references!, lorryReceipt: "0" },
    },
  );
  const row = rows.find((row) => row.label === "Lorry Receipt No.")!;
  assert.equal(row.sap, "0");
  assert.equal(row.status, "Not checked");
  assert.match(row.note!, /placeholder/);
});

test("old snapshots do not invent missing SAP references", () => {
  const rows = candidateEvidence(matchFixture.invoice, {
    ...matchFixture.result.lines[0].candidates[0],
    references: undefined,
  });
  assert.equal(
    rows.find((row) => row.label === "Invoice No.")?.status,
    "Not checked",
  );
  assert.equal(rows[0].status, "Not checked");
});

test("legacy display removes zero LR conflicts and avoids claiming goods never arrived", () => {
  const candidate = matchFixture.result.lines[0].candidates[0];
  const saved = {
    ...matchFixture.result,
    lines: [
      {
        ...matchFixture.result.lines[0],
        candidates: [
          {
            ...candidate,
            bad: ["different lorry receipt (0)", "different truck (TRUCK2)"],
          },
        ],
      },
    ],
  };
  const display = sapMatchPresentation(saved);
  assert.deepEqual(display.lines[0].candidates[0].bad, [
    "Different Vehicle No. (TRUCK2)",
  ]);
  assert.equal(saved.lines[0].candidates[0].bad.length, 2);
  assert.equal(
    sapMessage("The truck TRUCK1 has not been received yet"),
    "No matching open GRPO found for this invoice",
  );
});

test("part-billed GRPO quantity separates physical receipt, open balance, allocation and remainder", () => {
  const original = matchFixture.result.lines[0];
  const balances = quantityBalances({
    ...original,
    candidates: [
      { ...original.candidates[0], quantity: 50, open: 20, allocated: 10 },
    ],
  });
  assert.deepEqual(balances, {
    received: 50,
    available: 20,
    used: 10,
    remaining: 10,
  });
});

test("historical unverified pass checks are downgraded without changing allocation or decisions", () => {
  const result = {
    ...matchFixture.result,
    checkedAt: undefined,
    checks: [
      {
        id: "branch",
        lineIndex: null,
        sev: "pass" as const,
        open: false,
        title: "Branch not checked (no branch is saved for this ship-to state)",
      },
      {
        id: "period",
        lineIndex: null,
        sev: "pass" as const,
        open: false,
        title: "Posting Period is open",
      },
      {
        id: "tax",
        lineIndex: null,
        sev: "pass" as const,
        open: false,
        title: "GST type could not be verified from the GSTINs",
      },
    ],
  };
  assert.ok(
    truthfulChecks(result).every(
      (check) => check.sev === "unchecked" && !check.open,
    ),
  );
  assert.equal(
    result.checks[0].sev,
    "pass",
    "Saved audit data stays immutable",
  );
});

test("engine does not claim unknown branch, tax, posting period, rate or total were verified", () => {
  const source = matchFixture.result.lines[0].candidates[0];
  const invoice = {
    ...matchFixture.invoice,
    vendorGstin: null,
    shipToGstin: null,
    taxableTotal: null,
    lines: matchFixture.invoice.lines.map((line) => ({
      ...line,
      rate: null,
      amount: null,
    })),
  };
  const context: MatchContext = {
    vendor: matchFixture.vendor,
    ambiguousVendors: [],
    branch: null,
    itemMap: { I01: "TTR027" },
    items: { TTR027: { name: "Steel bar", inventory: true } },
    receipts: [
      {
        kind: "GRPO",
        docEntry: source.docEntry,
        docNum: source.docNum,
        lineNum: 0,
        date: "2026-06-20",
        cardCode: "TSPL001",
        itemCode: "TTR027",
        branchId: 1,
        warehouse: null,
        poDocEntry: 274,
        poDocNum: 274,
        poLineNum: 0,
        poRefs: ["274"],
        quantity: 2,
        openQty: 2,
        price: null,
        vehicle: "TRUCK1",
        vendorRef: invoice.invoiceNumber,
        eWayBill: null,
        lorryReceipt: "0",
      },
    ],
    poLines: [],
    existingInvoice: null,
    today: "2026-06-20",
    closedBefore: null,
  };
  const result = evaluateMatch({ invoice, context });
  for (const id of ["branch", "tax", "period", "rate-0", "total"]) {
    assert.equal(
      result.checks.find((check) => check.id === id)?.sev,
      "unchecked",
      id,
    );
    assert.equal(
      result.open.some((check) => check.id === id),
      false,
      "Unknown informational checks retain existing draft eligibility",
    );
  }
  assert.equal(
    result.lines[0].candidates[0].bad.some((reason) =>
      /Lorry Receipt/.test(reason),
    ),
    false,
  );
  assert.equal(result.lines[0].candidates[0].purchaseOrder?.lineNum, 0);
  assert.equal(result.lines[0].itemIdentification?.method, "saved-mapping");
  assert.notEqual(result.summary, "Everything matches");
});
