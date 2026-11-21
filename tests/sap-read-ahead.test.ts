import assert from "node:assert/strict";
import test from "node:test";
import type { MatchInvoice } from "../src/lib/sap-match/types";
import type { CaseMatchClient } from "../src/server/sap/match-data";
import {
  SapReadAhead,
  SAP_READ_AHEAD_MAX_AGE_MS,
} from "../src/server/sap/read-ahead";

const invoice = {
  invoiceNumber: "INV-001",
  vendorName: "Aster",
  vendorGstin: "27ABC",
  poReferences: ["PO-1"],
  vehicles: ["MH01AA1234"],
  lines: [{ description: "Steel", quantity: 2 }],
} as unknown as MatchInvoice;
const client = (methods: Record<string, unknown>) =>
  methods as unknown as CaseMatchClient;

test("read-ahead retains immutable SAP rows but duplicate checks, draft checks and writes stay fresh", async () => {
  let orders = 0,
    duplicates = 0,
    drafts = 0,
    writes = 0,
    selectedDocuments = 0;
  const source = client({
    listOpenPurchaseOrdersForVendor: async () => {
      orders++;
      return [{ DocEntry: 7, DocumentLines: [{ RemainingOpenQuantity: 2 }] }];
    },
    findInvoiceByReference: async () => {
      duplicates++;
      return { DocEntry: duplicates };
    },
    findDraftByVendorReference: async () => {
      drafts++;
      return null;
    },
    createDraft: async () => {
      writes++;
      return {};
    },
    getGrpo: async () => ({
      DocEntry: 7,
      DocumentLines: [{ RemainingOpenQuantity: 2 - selectedDocuments++ }],
    }),
  });
  const ahead = new SapReadAhead(() => 10_000);
  const captured = ahead.capture.clientForInvoice(invoice, source);
  await assert.rejects(captured.createDraft({}), /only permits read-only/);
  const original = await captured.listOpenPurchaseOrdersForVendor("V1");
  original[0].DocumentLines![0].RemainingOpenQuantity = 99;
  await captured.findInvoiceByReference("V1", "INV-001");
  await captured.findDraftByVendorReference("V1", "INV-001");
  assert.equal(
    (await captured.getGrpo(7)).DocumentLines![0].RemainingOpenQuantity,
    2,
  );
  const final = ahead.consume.clientForInvoice(invoice, source);
  const reused = await final.listOpenPurchaseOrdersForVendor("V1");
  assert.equal(reused[0].DocumentLines![0].RemainingOpenQuantity, 2);
  reused[0].DocumentLines![0].RemainingOpenQuantity = 88;
  assert.equal(
    (await final.listOpenPurchaseOrdersForVendor("V1"))[0].DocumentLines![0]
      .RemainingOpenQuantity,
    2,
  );
  assert.equal(orders, 1);
  assert.equal(
    (await final.findInvoiceByReference("V1", "INV-001"))!.DocEntry,
    2,
  );
  await final.findDraftByVendorReference("V1", "INV-001");
  await final.createDraft({});
  assert.equal(
    (await final.getGrpo(7)).DocumentLines![0].RemainingOpenQuantity,
    1,
    "Selected document balances used for draft validation must be read fresh",
  );
  assert.equal(duplicates, 2);
  assert.equal(drafts, 2);
  assert.equal(writes, 1);
  assert.equal(ahead.consume.checkedAt!(), new Date(10_000).toISOString());
});

test("every changed invoice input and every different SAP request bypasses prepared data", async () => {
  let calls = 0;
  const source = client({
    listOpenPurchaseOrdersForVendor: async () => [{ DocEntry: ++calls }],
  });
  const ahead = new SapReadAhead();
  await ahead.capture
    .clientForInvoice(invoice, source)
    .listOpenPurchaseOrdersForVendor("V1");
  for (const change of [
    { invoiceNumber: "INV-002" },
    { vendorName: "Other" },
    { vendorGstin: "OTHER" },
    { poReferences: ["PO-2"] },
    { vehicles: ["OTHER"] },
    { lines: [{ description: "Steel", quantity: 3 }] },
  ]) {
    await ahead.consume
      .clientForInvoice({ ...invoice, ...change } as MatchInvoice, source)
      .listOpenPurchaseOrdersForVendor("V1");
  }
  await ahead.consume
    .clientForInvoice(invoice, source)
    .listOpenPurchaseOrdersForVendor("V2");
  assert.equal(calls, 8);
  assert.equal(ahead.reusedReads, 0);
});

test("failed, expired and discarded preparations fall back to normal SAP reads", async () => {
  let now = 10_000,
    calls = 0;
  const source = client({
    listOpenPurchaseOrdersForVendor: async () => {
      if (++calls === 1) throw new Error("Temporary SAP failure");
      return [{ DocEntry: calls }];
    },
  });
  const ahead = new SapReadAhead(() => now);
  await assert.rejects(
    ahead.capture
      .clientForInvoice(invoice, source)
      .listOpenPurchaseOrdersForVendor("V1"),
  );
  assert.equal(
    (
      await ahead.consume
        .clientForInvoice(invoice, source)
        .listOpenPurchaseOrdersForVendor("V1")
    )[0].DocEntry,
    2,
  );
  await ahead.capture
    .clientForInvoice(invoice, source)
    .listOpenPurchaseOrdersForVendor("V1");
  now += SAP_READ_AHEAD_MAX_AGE_MS + 1;
  assert.equal(
    (
      await ahead.consume
        .clientForInvoice(invoice, source)
        .listOpenPurchaseOrdersForVendor("V1")
    )[0].DocEntry,
    4,
  );
  ahead.dispose();
  await ahead.consume
    .clientForInvoice(invoice, source)
    .listOpenPurchaseOrdersForVendor("V1");
  assert.equal(calls, 5);
});

test("an in-flight read can overlap verification but is checked again for expiry before reuse", async () => {
  let now = 0,
    calls = 0;
  let finish!: (value: unknown[]) => void;
  const source = client({
    listOpenPurchaseOrdersForVendor: async () => {
      if (++calls === 1)
        return new Promise((resolve) => {
          finish = resolve;
        });
      return [{ DocEntry: 2 }];
    },
  });
  const ahead = new SapReadAhead(() => now);
  const preparation = ahead.capture
    .clientForInvoice(invoice, source)
    .listOpenPurchaseOrdersForVendor("V1");
  await Promise.resolve();
  const matching = ahead.consume
    .clientForInvoice(invoice, source)
    .listOpenPurchaseOrdersForVendor("V1");
  now = SAP_READ_AHEAD_MAX_AGE_MS + 1;
  finish([{ DocEntry: 1 }]);
  await preparation;
  assert.equal((await matching)[0].DocEntry, 2);
  assert.equal(calls, 2);
});

test("receipt discovery retains its search evidence and never reuses a different reference", async () => {
  let calls = 0;
  const event = {
    field: "NumAtCard",
    value: "INV-001",
    identifiers: [{ field: "NumAtCard", value: "INV-001" }],
    documentsRead: 1,
    limit: 100,
  };
  const source = client({
    findOpenReceiptDocumentsForInvoice: async (input: {
      onSearch?: (value: unknown) => void;
    }) => {
      calls++;
      input.onSearch?.(event);
      return [{ DocEntry: 7 }];
    },
  });
  const ahead = new SapReadAhead();
  const input = {
    invoiceNumber: "INV-001",
    eWayBill: null,
    lorryReceipt: null,
    vehicles: [],
  };
  await ahead.capture
    .clientForInvoice(invoice, source)
    .findOpenReceiptDocumentsForInvoice(input);
  const events: unknown[] = [];
  const final = ahead.consume.clientForInvoice(invoice, source);
  assert.equal(
    (
      await final.findOpenReceiptDocumentsForInvoice({
        ...input,
        onSearch: (value) => events.push(value),
      })
    )[0].DocEntry,
    7,
  );
  assert.deepEqual(events, [event]);
  assert.equal(calls, 1);
  await final.findOpenReceiptDocumentsForInvoice({
    ...input,
    invoiceNumber: "OTHER",
  });
  assert.equal(calls, 2);
});

test("oversized SAP responses are not retained for reuse", async () => {
  let calls = 0;
  const source = client({
    listOpenPurchaseOrdersForVendor: async () => {
      calls++;
      return [{ DocEntry: calls, Comments: "x".repeat(8 * 1024 * 1024) }];
    },
  });
  const ahead = new SapReadAhead();
  await ahead.capture
    .clientForInvoice(invoice, source)
    .listOpenPurchaseOrdersForVendor("V1");
  await ahead.consume
    .clientForInvoice(invoice, source)
    .listOpenPurchaseOrdersForVendor("V1");
  assert.equal(calls, 2);
  assert.equal(ahead.reusedReads, 0);
});
