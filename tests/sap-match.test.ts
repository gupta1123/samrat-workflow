import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateMatch, itemMappingKey } from "../src/lib/sap-match/engine";
import {
  EMPTY_MATCH_STATE,
  type MatchContext,
  type MatchInvoice,
  type MatchState,
  type SapPoLine,
  type SapReceiptLine,
} from "../src/lib/sap-match/types";

const TATA = { cardCode: "V-TATA01", cardName: "TATA STEEL LIMITED" };
const ITEMS = {
  "BW-TW20-091": { name: "Binding Wire TW20 0.91mm", inventory: true },
  "TMT-550SD-10": { name: "TMT Fe550SD 10mm", inventory: true },
  "TMT-550SD-16": { name: "TMT Fe550SD 16mm", inventory: true },
  "TMT-500D-16": { name: "TMT Fe500D 16mm", inventory: true },
  "SRV-FRT": { name: "Freight inward", inventory: false },
};
const ITEM_MAP: Record<string, string> = {
  "3434405": "BW-TW20-091",
  "1428337": "TMT-550SD-10",
  SRVFRT: "SRV-FRT",
};

function receipt(
  docNum: number,
  overrides: Partial<SapReceiptLine> & { poRef?: string; poQty?: number; poRate?: number } = {},
): { receipt: SapReceiptLine; po: SapPoLine } {
  const poRef = overrides.poRef ?? "TGPO26-0412";
  const poQty = overrides.poQty ?? 100;
  const poRate = overrides.poRate ?? 68000;
  const poEntry = 500 + (Number(poRef.replace(/\D/g, "")) % 1000);
  const { poRef: _a, poQty: _b, poRate: _c, ...rest } = overrides;
  void _a;
  void _b;
  void _c;
  return {
    receipt: {
      kind: "GRPO",
      docEntry: 8000 + docNum,
      docNum,
      lineNum: 0,
      date: "2026-06-13",
      cardCode: TATA.cardCode,
      itemCode: "BW-TW20-091",
      branchId: 1,
      warehouse: "HYD-01",
      poDocEntry: poEntry,
      poDocNum: poEntry,
      poLineNum: 0,
      poRefs: [poRef],
      quantity: 34.98,
      openQty: 34.98,
      price: poRate,
      vehicle: null,
      vendorRef: null,
      eWayBill: null,
      lorryReceipt: null,
      ...rest,
    },
    po: {
      kind: "PO",
      docEntry: poEntry,
      docNum: poEntry,
      lineNum: 0,
      date: "2026-06-02",
      cardCode: TATA.cardCode,
      itemCode: rest.itemCode ?? "BW-TW20-091",
      branchId: rest.branchId ?? 1,
      warehouse: "HYD-01",
      poRefs: [poRef],
      quantity: poQty,
      openQty: poQty,
      price: poRate,
      lineTotal: poQty * poRate,
      openAmount: poQty * poRate,
    },
  };
}

function context(
  receipts: Array<ReturnType<typeof receipt>>,
  extra: Partial<MatchContext> = {},
): MatchContext {
  const pos = new Map<number, SapPoLine>();
  for (const entry of receipts) pos.set(entry.po.docEntry, entry.po);
  return {
    vendor: TATA,
    ambiguousVendors: [],
    branch: { bplId: 1, name: "Hyderabad", stateCode: "36", warehouse: "HYD-01" },
    itemMap: ITEM_MAP,
    items: ITEMS,
    receipts: receipts.map((entry) => entry.receipt),
    poLines: [...pos.values()],
    existingInvoice: null,
    today: "2026-09-28",
    closedBefore: null,
    ...extra,
  };
}

function invoice(overrides: Partial<MatchInvoice> = {}): MatchInvoice {
  return {
    invoiceNumber: "1444099137",
    invoiceDate: "2026-06-10",
    vendorName: "TATA STEEL LIMITED",
    vendorGstin: "20AAACT2803M2ZO",
    shipToGstin: "36AAQCS9189P1ZY",
    poReferences: ["TGPO26-0412"],
    vehicles: ["JH02BR9642"],
    eWayBill: null,
    lorryReceipt: null,
    taxCharged: "igst",
    taxRatePct: 18,
    currency: "INR",
    freightAmount: 130685.28,
    taxableTotal: 34.98 * 68000 + 130685.28,
    taxTotal: null,
    total: null,
    lines: [
      {
        index: 0,
        vendorItemCode: "3434405",
        description: "Binding Wire TW20- 0.91 mm PIP Compact",
        hsnSac: "72171020",
        quantity: 34.98,
        unit: "MT",
        rate: 68000,
        amount: 34.98 * 68000,
      },
    ],
    ...overrides,
  };
}

const truck = { vehicle: "JH02BR9642", vendorRef: "1444099137" };

function decide(state: MatchState, id: string, choice: string, reason?: string): MatchState {
  return {
    ...state,
    decisions: { ...state.decisions, [id]: { choice, reason, at: "2026-09-28T10:00:00Z" } },
  };
}

test("clean match: one truck, one receipt is ready and builds a linked payload", () => {
  const result = evaluateMatch({
    invoice: invoice(),
    context: context([receipt(4412, truck)]),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.method, "3-way");
  assert.equal(result.payload?.lines.length, 1);
  const line = result.payload!.lines[0];
  assert.equal(line.baseType, 20);
  assert.equal(line.baseEntry, 8000 + 4412);
  assert.equal(line.quantity, 34.98);
  assert.equal(line.unitPrice, null);
  assert.equal(result.payload?.freightExpense, 130685.28);
  assert.equal(result.payload?.docDate, "2026-06-10");
  assert.equal(result.payload?.numAtCard, "1444099137");
});

test("a small short receipt needs a decision and can only be settled by stores or a return", () => {
  const inv = invoice({
    invoiceNumber: "4725013687",
    vendorGstin: "37AAACT2803M1ZA",
    shipToGstin: "37AAQCS9189P1ZW",
    taxCharged: "split",
    lines: [{ index: 0, vendorItemCode: "1428337", description: "TMT 10mm", hsnSac: null, quantity: 41.8, unit: "MT", rate: 58308, amount: 41.8 * 58308 }],
    freightAmount: 0,
    taxableTotal: 41.8 * 58308,
    poReferences: ["APPO26-0233"],
    vehicles: ["TN18CA0465"],
  });
  const ctx = context(
    [receipt(1182, { itemCode: "TMT-550SD-10", branchId: 2, quantity: 41.52, openQty: 41.52, price: 58308, poRef: "APPO26-0233", poRate: 58308, poQty: 150, vehicle: "TN18CA0465", vendorRef: "4725013687" })],
    { branch: { bplId: 2, name: "Kadapa", stateCode: "37", warehouse: "KDP-01" } },
  );
  const result = evaluateMatch({ invoice: inv, context: ctx });
  assert.equal(result.status, "review");
  const check = result.checks.find((c) => c.id === "qty-0")!;
  assert.equal(check.sev, "ack");
  assert.deepEqual(
    check.options!.map((o) => o.choice),
    ["stores", "return"],
  );
  assert.ok(!check.options!.some((o) => /debit/i.test(o.title)));
  // The shortfall must not also appear as a total difference.
  assert.ok(!result.checks.some((c) => c.id === "total" && c.open));

  const stores = evaluateMatch({ invoice: inv, context: ctx, state: decide(EMPTY_MATCH_STATE, "qty-0", "stores") });
  assert.equal(stores.status, "waiting");
  const returned = evaluateMatch({ invoice: inv, context: ctx, state: decide(EMPTY_MATCH_STATE, "qty-0", "return") });
  assert.equal(returned.status, "returned");

  const strict = evaluateMatch({ invoice: inv, context: ctx, rules: { qtyTolerancePct: 0.5 } });
  assert.equal(strict.status, "blocked");
});

test("a rate above the limit needs a written reason", () => {
  const inv = invoice({
    invoiceNumber: "3432010883",
    poReferences: ["APPO26-0229"],
    vehicles: ["AP02TH2989"],
    freightAmount: 0,
    taxableTotal: 30 * 63887,
    lines: [{ index: 0, vendorItemCode: "3434405", description: "Binding Wire", hsnSac: null, quantity: 30, unit: "MT", rate: 63887, amount: 30 * 63887 }],
  });
  const ctx = context([
    receipt(1190, { quantity: 30, openQty: 30, price: 62500, poRate: 62500, poRef: "APPO26-0229", poQty: 80, vehicle: "AP02TH2989", vendorRef: "3432010883" }),
  ]);
  const first = evaluateMatch({ invoice: inv, context: ctx });
  assert.equal(first.status, "review");
  const rate = first.checks.find((c) => c.id === "rate-0")!;
  assert.equal(rate.sev, "confirm");
  assert.equal(rate.options![0].needsReason, true);

  const noReason = evaluateMatch({ invoice: inv, context: ctx, state: decide(EMPTY_MATCH_STATE, "rate-0", "confirm") });
  assert.equal(noReason.status, "review", "a decision without a reason is not accepted");

  const done = evaluateMatch({ invoice: inv, context: ctx, state: decide(EMPTY_MATCH_STATE, "rate-0", "confirm", "Market rise agreed by phone") });
  assert.equal(done.status, "ready");
  assert.equal(done.payload!.lines[0].unitPrice, 63887);
});

test("the Tata Wiron invoice rate below PO 275 still needs a written approval", () => {
  const inv = invoice({
    poReferences: ["TGPO26-"],
    freightAmount: 0,
    taxableTotal: 34.98 * 68000,
  });
  const ctx = context([
    receipt(691, {
      poRef: "275",
      poRate: 72750,
      price: 72750,
      poQty: 100,
      vendorRef: "1444099137",
      itemCode: "BW-TW20-091",
      quantity: 34.98,
      openQty: 34.98,
    }),
  ]);
  const first = evaluateMatch({ invoice: inv, context: ctx });
  const rate = first.checks.find((check) => check.id === "rate-0")!;
  assert.equal(rate.sev, "confirm");
  assert.match(rate.title, /below the PO/);
  assert.equal(rate.options?.[0].needsReason, true);
});

test("an invoice that arrives before the truck waits", () => {
  const inv = invoice({ poReferences: ["APPO26-0241"], vehicles: ["AP39TB7781"] });
  const only = receipt(1, { poRef: "APPO26-0241" });
  const ctx = context([], { poLines: [only.po] });
  const result = evaluateMatch({ invoice: inv, context: ctx });
  assert.equal(result.status, "waiting");
  assert.equal(result.checks.find((c) => c.id === "rcpt-0")!.sev, "wait");
});

test("one invoice, two trucks: quantity is split across two receipts", () => {
  const inv = invoice({
    vehicles: ["TS07UH4410", "TS08JK2231"],
    poReferences: ["TGPO26-0418"],
    freightAmount: 0,
    taxableTotal: 52.4 * 58900,
    lines: [{ index: 0, vendorItemCode: "3434405", description: "Binding wire", hsnSac: null, quantity: 52.4, unit: "MT", rate: 58900, amount: 52.4 * 58900 }],
  });
  const common = { poRef: "TGPO26-0418", poRate: 58900, price: 58900, vendorRef: "1444099137" };
  const ctx = context([
    receipt(4431, { ...common, quantity: 30.1, openQty: 30.1, vehicle: "TS07UH4410" }),
    receipt(4433, { ...common, quantity: 22.3, openQty: 22.3, vehicle: "TS08JK2231", date: "2026-06-14" }),
    receipt(4402, { ...common, quantity: 18, openQty: 18, vehicle: "TS09AB7712", vendorRef: "1444099001", date: "2026-06-08" }),
  ]);
  const result = evaluateMatch({ invoice: inv, context: ctx });
  assert.equal(result.status, "ready");
  assert.equal(result.payload!.lines.length, 2);
  assert.equal(Math.round(result.payload!.lines.reduce((s, l) => s + l.quantity, 0) * 1000) / 1000, 52.4);
  assert.deepEqual(
    result.payload!.lines.map((l) => l.baseEntry).sort(),
    [8000 + 4431, 8000 + 4433].sort(),
  );
});

test("a part bill asks for confirmation, then is ready", () => {
  const inv = invoice({
    poReferences: ["APPO26-0247"],
    vehicles: ["AP21TC5510"],
    freightAmount: 0,
    taxableTotal: 20 * 62500,
    lines: [{ index: 0, vendorItemCode: "3434405", description: "Binding wire", hsnSac: null, quantity: 20, unit: "MT", rate: 62500, amount: 20 * 62500 }],
  });
  const ctx = context([
    receipt(1205, { quantity: 50, openQty: 50, price: 62500, poRef: "APPO26-0247", poRate: 62500, vehicle: "AP21TC5510", note: "Two trucks were unloaded on one receipt" }),
  ]);
  const first = evaluateMatch({ invoice: inv, context: ctx });
  assert.equal(first.status, "review");
  const part = first.checks.find((c) => c.id.startsWith("part-0-"))!;
  assert.equal(part.sev, "ack");
  const done = evaluateMatch({ invoice: inv, context: ctx, state: decide(EMPTY_MATCH_STATE, part.id, "ok") });
  assert.equal(done.status, "ready");
  assert.equal(done.payload!.lines[0].quantity, 20);
});

test("billing more than was received is blocked and never invents stock", () => {
  const inv = invoice({
    poReferences: ["APPO26-0250"],
    vehicles: ["AP04TT9021"],
    freightAmount: 0,
    taxableTotal: 70 * 58308,
    lines: [{ index: 0, vendorItemCode: "1428337", description: "TMT 10", hsnSac: null, quantity: 70, unit: "MT", rate: 58308, amount: 70 * 58308 }],
  });
  const ctx = context([
    receipt(1210, { itemCode: "TMT-550SD-10", quantity: 50, openQty: 50, price: 58308, poRef: "APPO26-0250", poRate: 58308, poQty: 50, vehicle: "AP04TT9021", vendorRef: "1444099137" }),
  ]);
  const result = evaluateMatch({ invoice: inv, context: ctx });
  assert.equal(result.status, "blocked");
  const qty = result.checks.find((c) => c.id === "qty-0")!;
  assert.equal(qty.sev, "block");
  assert.deepEqual(qty.options!.map((o) => o.choice), ["return", "hold"]);
  assert.equal(result.lines[0].allocatedQty, 50);
});

test("an item that is not linked blocks and suggests SAP items", () => {
  const inv = invoice({
    lines: [{ index: 0, vendorItemCode: "1502211", description: "TISCON-TMT IS1786 FE550SD 16 mm", hsnSac: null, quantity: 24.3, unit: "MT", rate: 57600, amount: 24.3 * 57600 }],
  });
  const result = evaluateMatch({ invoice: inv, context: context([]) });
  assert.equal(result.status, "blocked");
  const check = result.checks.find((c) => c.id === "map-0")!;
  assert.ok(check.itemSuggestions!.some((s) => s.itemCode === "TMT-550SD-16"));
  assert.equal(itemMappingKey({ vendorItemCode: "15-02211" }), "1502211");
  assert.equal(itemMappingKey({ vendorItemCode: null, description: "Wire 2mm" }), "D:WIRE2MM");
});

test("an invoice already in SAP is a duplicate and can be closed", () => {
  const ctx = context([receipt(4390, truck)], { existingInvoice: { docNum: 23755 } });
  const first = evaluateMatch({ invoice: invoice(), context: ctx });
  assert.equal(first.status, "blocked");
  const closed = evaluateMatch({ invoice: invoice(), context: ctx, state: decide(EMPTY_MATCH_STATE, "dup", "close") });
  assert.equal(closed.status, "closed");
});

test("IGST on a same-state supply is blocked", () => {
  const result = evaluateMatch({
    invoice: invoice({ vendorGstin: "37AAACT2803M1ZA", shipToGstin: "37AAQCS9189P1ZW", taxCharged: "igst" }),
    context: context([receipt(4412, truck)]),
  });
  assert.equal(result.status, "blocked");
  assert.match(result.checks.find((c) => c.id === "tax")!.title, /Wrong GST/);
});

test("a service bill within the PO is a 2-way match", () => {
  const po: SapPoLine = {
    kind: "PO", docEntry: 71091, docNum: 91, lineNum: 0, date: "2026-04-01", cardCode: "V-SSLT01", itemCode: "SRV-FRT",
    branchId: 1, warehouse: null, poRefs: ["KDP-SPO-0091"], quantity: 1, openQty: 1, price: 200000, lineTotal: 200000, openAmount: 121500,
  };
  const inv = invoice({
    vendorName: "SRI SRINIVASA LORRY TRANSPORT", vendorGstin: "37ABCFS4410K1Z2", shipToGstin: "37AAQCS9189P1ZW", taxCharged: "split",
    poReferences: ["KDP-SPO-0091"], vehicles: [], freightAmount: 0, taxableTotal: 38500,
    lines: [{ index: 0, vendorItemCode: "SRV-FRT", description: "Freight inward", hsnSac: "996511", quantity: null, unit: null, rate: null, amount: 38500 }],
  });
  const ctx = context([], { vendor: { cardCode: "V-SSLT01", cardName: "SRI SRINIVASA LORRY TRANSPORT" }, poLines: [po] });
  const result = evaluateMatch({ invoice: inv, context: ctx });
  assert.equal(result.method, "2-way");
  assert.equal(result.status, "ready");
  assert.equal(result.payload!.lines[0].baseType, 22);
  assert.equal(result.payload!.lines[0].lineTotal, 38500);
});

test("a service bill above the PO needs a reason", () => {
  const po: SapPoLine = {
    kind: "PO", docEntry: 71102, docNum: 102, lineNum: 0, date: "2026-06-18", cardCode: "V-SEW01", itemCode: "SRV-FRT",
    branchId: 1, warehouse: null, poRefs: ["KDP-SPO-0102"], quantity: 1, openQty: 1, price: 50000, lineTotal: 50000, openAmount: 50000,
  };
  const inv = invoice({
    vendorName: "SAI ENGINEERING WORKS", vendorGstin: "37AAKFS2210L1Z9", shipToGstin: "37AAQCS9189P1ZW", taxCharged: "split",
    poReferences: ["KDP-SPO-0102"], vehicles: [], freightAmount: 0, taxableTotal: 70000,
    lines: [{ index: 0, vendorItemCode: "SRV-FRT", description: "Repair", hsnSac: null, quantity: null, unit: null, rate: null, amount: 70000 }],
  });
  const ctx = context([], { vendor: { cardCode: "V-SEW01", cardName: "SAI ENGINEERING WORKS" }, poLines: [po] });
  const result = evaluateMatch({ invoice: inv, context: ctx });
  assert.equal(result.status, "review");
  assert.equal(result.checks.find((c) => c.id === "amt-0")!.sev, "confirm");
  const done = evaluateMatch({ invoice: inv, context: ctx, state: decide(EMPTY_MATCH_STATE, "amt-0", "confirm", "Extra parts approved on site") });
  assert.equal(done.status, "ready");
});

test("a closed SAP month can be booked on today's date, keeping the GST date", () => {
  const ctx = context([receipt(4368, truck)], { closedBefore: "2026-06-01" });
  const inv = invoice({ invoiceDate: "2026-05-29" });
  const first = evaluateMatch({ invoice: inv, context: ctx });
  assert.equal(first.status, "blocked");
  const done = evaluateMatch({ invoice: inv, context: ctx, state: decide(EMPTY_MATCH_STATE, "period", "use-today") });
  assert.equal(done.status, "ready");
  assert.equal(done.payload!.docDate, "2026-09-28");
  assert.equal(done.payload!.taxDate, "2026-05-29");
});

test("a receipt matched only on PO and quantity must be confirmed", () => {
  const result = evaluateMatch({ invoice: invoice(), context: context([receipt(4412)]) });
  assert.equal(result.status, "review");
  assert.equal(result.checks.find((c) => c.id === "anchor-0")!.sev, "ack");
});

test("receipts already billed or at another branch are rejected with a reason", () => {
  const ctx = context([
    receipt(4371, { ...truck, openQty: 0, invoicedBy: "A/P 23702" }),
    receipt(1188, { branchId: 2, vehicle: "AP02TG1180" }),
    receipt(4412, truck),
  ]);
  const result = evaluateMatch({ invoice: invoice(), context: ctx });
  const reasons = result.lines[0].candidates.map((c) => c.rejected);
  assert.ok(reasons.some((r) => /Already billed \(A\/P 23702\)/.test(r ?? "")));
  assert.ok(reasons.some((r) => /another branch/.test(r ?? "")));
  assert.equal(result.status, "ready");
});

test("freight paid separately is left out and confirmed", () => {
  const result = evaluateMatch({
    invoice: invoice(),
    context: context([receipt(4412, truck)]),
    rules: { freightPolicy: "separate" },
  });
  assert.equal(result.status, "review");
  assert.equal(result.payload!.freightExpense, null);
  assert.equal(result.payload!.freightExcluded, 130685.28);
  const done = evaluateMatch({
    invoice: invoice(),
    context: context([receipt(4412, truck)]),
    rules: { freightPolicy: "separate" },
    state: decide(EMPTY_MATCH_STATE, "freight", "ok"),
  });
  assert.equal(done.status, "ready");
});

test("manual allocation overrides the automatic choice", () => {
  const ctx = context([receipt(4412, truck), receipt(4398, { vehicle: "JH05AK1120", quantity: 40, openQty: 40, date: "2026-06-06" })]);
  const result = evaluateMatch({
    invoice: invoice(),
    context: ctx,
    state: { decisions: {}, allocations: { "0": { [`${8000 + 4398}:${0}`]: 34.98 } } },
  });
  assert.equal(result.lines[0].manual, true);
  assert.equal(result.payload!.lines[0].baseEntry, 8000 + 4398);
});

test("an unknown vendor blocks matching", () => {
  const result = evaluateMatch({ invoice: invoice(), context: context([receipt(4412, truck)], { vendor: null }) });
  assert.equal(result.status, "blocked");
  assert.ok(result.checks.some((c) => c.id === "vendor" && c.sev === "block"));
});
