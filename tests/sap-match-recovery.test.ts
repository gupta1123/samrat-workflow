import assert from "node:assert/strict";
import { test } from "node:test";
import {
  needsInvoiceVerification,
  retryInvoiceVerification,
} from "../src/lib/sap-match-recovery";

test("verification failures choose analysis recovery while SAP failures keep their own retry", () => {
  assert.equal(
    needsInvoiceVerification({ available: false, recoveryAction: "reanalyze" }),
    true,
  );
  for (const reason of [
    "Invoice item extraction is incomplete or unverified. Review the invoice's original pages and analyze again before SAP matching.",
    "The invoice cover and billing pages need a source-reviewed invoice assembly.",
    "Invoice item extraction is incomplete: no product rows were saved.",
  ])
    assert.equal(needsInvoiceVerification({ available: false, reason }), true);
  for (const reason of [
    "No open SAP receipt found",
    "SAP lines do not match",
    "SAP is temporarily unavailable",
  ])
    assert.equal(needsInvoiceVerification({ available: false, reason }), false);
  assert.equal(
    needsInvoiceVerification({ available: true, recoveryAction: "reanalyze" }),
    false,
  );
});

test("verification retry queues the same case with its saved options and no SAP or upload action", async () => {
  const calls: unknown[] = [];
  await retryInvoiceVerification("case-1", {
    read: async (id) => ({
      case: {
        id,
        status: "completed",
        processingMeta: {
          analysisMode: "standard",
          comparisonOptions: { considerFormatting: true },
        },
      },
      files: [{}],
    }),
    enqueue: async (...args) => {
      calls.push(args);
    },
  });
  assert.deepEqual(calls, [
    [
      "case-1",
      {
        analysisMode: "standard",
        comparisonOptions: { considerFormatting: true },
      },
    ],
  ]);
});

test("an active analysis is reused, final decisions and missing source files cannot be reanalysed", async () => {
  let enqueues = 0;
  const enqueue = async () => {
    enqueues++;
  };
  await retryInvoiceVerification("case-1", {
    read: async (id) => ({ case: { id, status: "processing" }, files: [{}] }),
    enqueue,
  });
  for (const status of ["accepted", "rejected", "draft"])
    await assert.rejects(
      retryInvoiceVerification("case-1", {
        read: async (id) => ({ case: { id, status }, files: [{}] }),
        enqueue,
      }),
    );
  await assert.rejects(
    retryInvoiceVerification("case-1", {
      read: async (id) => ({ case: { id, status: "completed" }, files: [] }),
      enqueue,
    }),
  );
  await assert.rejects(
    retryInvoiceVerification("case-1", {
      read: async () => ({
        case: { id: "other", status: "completed" },
        files: [{}],
      }),
      enqueue,
    }),
  );
  assert.equal(enqueues, 0);
});

test("a failed enqueue stays failed so the UI cannot announce a started check", async () => {
  await assert.rejects(
    retryInvoiceVerification("case-1", {
      read: async (id) => ({ case: { id, status: "completed" }, files: [{}] }),
      enqueue: async () => {
        throw new Error("enqueue unavailable");
      },
    }),
    /enqueue unavailable/,
  );
});
