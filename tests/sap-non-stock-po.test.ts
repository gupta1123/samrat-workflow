import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateMatch, itemMappingKey } from "../src/lib/sap-match/engine";
import type {
  MatchContext,
  MatchInvoice,
  MatchState,
} from "../src/lib/sap-match/types";
import { mapPoLines } from "../src/server/sap/match-mapping";
import { priceReviewDetails } from "../src/lib/sap-match/price-review";
import {
  buildMatchedDraftPayload,
  revalidateNonStockPoItems,
} from "../src/server/sap/match-draft";

function fixture() {
  const descriptions = [
    "A4 first publication",
    "A3 first publication",
    "A4 second publication",
    "A3 second publication",
  ];
  const rates = [8.25, 13, 8.25, 13];
  const document = {
    DocEntry: 880,
    DocNum: 475,
    CardCode: "V-PUBLISHER",
    DocType: "dDocument_Items",
    DocCurrency: "INR",
    DocumentStatus: "bost_Open",
    Cancelled: "tNO",
    Comments: "August publication for the northern region",
    DocumentLines: descriptions.map((FreeText, index) => ({
      LineNum: index,
      ItemCode: "EXP-PRINT",
      ItemDescription: "Marketing expense",
      FreeText,
      Quantity: 350,
      RemainingOpenQuantity: 350,
      Price: rates[index],
      LineTotal: rates[index] * 350,
      LineStatus: "bost_Open",
      AccountCode: "AC-PRINT",
    })),
  };
  const invoice: MatchInvoice = {
    supplyNature: "goods",
    invoiceNumber: "PUB-116",
    invoiceDate: "2026-08-10",
    vendorName: "Publisher",
    vendorGstin: null,
    shipToGstin: null,
    poReferences: ["REGION/475"],
    vehicles: [],
    eWayBill: null,
    lorryReceipt: null,
    taxCharged: "unknown",
    taxRatePct: null,
    currency: "INR",
    freightAmount: 0,
    taxableTotal: 14875,
    taxTotal: 2677.5,
    total: 17552.5,
    lines: descriptions.map((description, index) => ({
      index,
      vendorItemCode: null,
      description,
      hsnSac: null,
      quantity: 350,
      unit: "Nos",
      rate: rates[index],
      amount: rates[index] * 350,
    })),
  };
  const context: MatchContext = {
    vendor: { cardCode: "V-PUBLISHER", cardName: "Publisher" },
    ambiguousVendors: [],
    branch: null,
    itemMap: {},
    items: { "EXP-PRINT": { name: "Marketing expense", inventory: false } },
    receipts: [],
    poLines: mapPoLines([document]),
    existingInvoice: null,
    today: "2026-10-15",
    closedBefore: null,
  };
  const state: MatchState = {
    decisions: {},
    allocations: Object.fromEntries(
      invoice.lines.map((line) => [
        String(line.index),
        { [`880:${line.index}`]: line.amount! },
      ]),
    ),
  };
  return { document, invoice, context, state };
}

test("SAP free text and header remarks survive mapping without replacing the actual item name", () => {
  const { context } = fixture();
  assert.equal(context.poLines[0].description, "Marketing expense");
  assert.equal(context.poLines[0].lineRemarks, "A4 first publication");
  assert.equal(
    context.poLines[0].headerRemarks,
    "August publication for the northern region",
  );
});

test("equal amounts/quantities and a prefixed PO number never automatically establish an item or PO link", () => {
  const { invoice, context } = fixture();
  const result = evaluateMatch({ invoice, context });
  assert.equal(result.status, "blocked");
  assert.equal(result.payload, null);
  assert.ok(
    result.lines.every(
      (line) => line.kind === "unmapped" && line.itemCode === null,
    ),
  );
  assert.equal(result.lines[0].nonStockPoCandidates?.length, 4);
  const candidate = result.lines[0].nonStockPoCandidates![0];
  assert.equal(candidate.allocated, 0);
  assert.equal(candidate.score, 0);
  assert.equal(candidate.poEvidence?.lineRemarks, "A4 first publication");
  assert.equal(candidate.references?.po[0], "475");
  assert.ok(
    candidate.bad.includes(
      "Printed PO reference not confirmed; explicitly confirm this PO and line",
    ),
  );
  assert.deepEqual(context.itemMap, {});
});

test("a SIPL PO reference identifies non-stock PO evidence but still requires every line to be confirmed", () => {
  const { invoice, context } = fixture();
  invoice.poReferences = ["SIPL/475"];
  const result = evaluateMatch({ invoice, context });
  assert.equal(result.status, "blocked");
  assert.equal(result.payload, null);
  for (const line of result.lines) {
    assert.equal(line.kind, "unmapped");
    assert.equal(line.itemCode, null);
    assert.equal(line.allocatedQty, 0);
    assert.equal(line.nonStockPoCandidates?.length, 4);
    assert.ok(
      line.nonStockPoCandidates!.every(
        (candidate) => candidate.allocated === 0,
      ),
    );
    assert.ok(
      line.nonStockPoCandidates!.every((candidate) =>
        candidate.good.includes(
          "Invoice PO reference identifies this SAP PO; confirm its line",
        ),
      ),
    );
    assert.ok(
      line.nonStockPoCandidates!.every(
        (candidate) =>
          !candidate.bad.some((message) =>
            message.startsWith("Printed PO reference not confirmed"),
          ),
      ),
    );
  }
  assert.deepEqual(context.itemMap, {});
  assert.equal(invoice.supplyNature, "goods");
  for (const inventory of [true, null]) {
    const next = structuredClone(context);
    next.items["EXP-PRINT"].inventory = inventory;
    const blocked = evaluateMatch({ invoice, context: next });
    assert.equal(blocked.payload, null);
    assert.ok(
      blocked.lines.every((line) => !line.nonStockPoCandidates?.length),
    );
  }
});

test("explicit confirmation of all four non-stock PO lines builds a quantity-based PO draft, not service quantities or a GRPO", () => {
  const { invoice, context, state, document } = fixture();
  const result = evaluateMatch({ invoice, context, state });
  assert.equal(
    invoice.supplyNature,
    "goods",
    "Do not relabel physical goods as services",
  );
  assert.equal(result.status, "ready");
  assert.equal(result.method, "2-way");
  assert.ok(
    result.lines.every(
      (line) =>
        line.kind === "non-stock" &&
        line.itemIdentification?.method === "confirmed-po-line",
    ),
  );
  assert.deepEqual(result.baseDocuments, [
    { kind: "PO", docEntry: 880, docNum: 475 },
  ]);
  assert.deepEqual(context.itemMap, {});
  const plan = result.payload!;
  assert.equal(plan.bookedTaxable, 14875);
  assert.equal(plan.difference, 0);
  assert.deepEqual(
    plan.lines.map((line) => ({
      base: line.baseType,
      entry: line.baseEntry,
      line: line.baseLine,
      code: line.itemCode,
      qty: line.quantity,
      price: line.unitPrice,
    })),
    [
      {
        base: 22,
        entry: 880,
        line: 0,
        code: "EXP-PRINT",
        qty: 350,
        price: 8.25,
      },
      { base: 22, entry: 880, line: 1, code: "EXP-PRINT", qty: 350, price: 13 },
      {
        base: 22,
        entry: 880,
        line: 2,
        code: "EXP-PRINT",
        qty: 350,
        price: 8.25,
      },
      { base: 22, entry: 880, line: 3, code: "EXP-PRINT", qty: 350, price: 13 },
    ],
  );
  const { payload } = buildMatchedDraftPayload({
    caseId: "review",
    plan,
    bases: new Map([["22:880", document]]),
    freightExpenseCode: null,
  });
  assert.equal(payload.DocType, "dDocument_Items");
  assert.deepEqual(
    (payload.DocumentLines as Array<Record<string, unknown>>).map(
      (line) => line.Quantity,
    ),
    [350, 350, 350, 350],
  );
});

test("even a previously linked non-stock item and an exact PO reference need explicit goods PO-line confirmation", () => {
  const { invoice, context } = fixture();
  invoice.poReferences = ["475"];
  invoice.lines.forEach((line) => {
    line.vendorItemCode = "EXP-PRINT";
  });
  const result = evaluateMatch({ invoice, context });
  assert.equal(result.status, "blocked");
  assert.equal(result.payload, null);
  assert.ok(
    result.lines.every(
      (line) => line.kind === "non-stock" && line.allocatedQty === 0,
    ),
  );
});

test("stock items cannot be selected through the non-stock alternatives even with a crafted allocation", () => {
  const { invoice, context, state } = fixture();
  context.items["EXP-PRINT"].inventory = true;
  const result = evaluateMatch({ invoice, context, state });
  assert.equal(result.status, "blocked");
  assert.equal(result.payload, null);
  assert.ok(result.lines.every((line) => !line.nonStockPoCandidates?.length));
});

test("non-stock goods with an existing open receipt preserve their GRPO-based material flow", () => {
  const { invoice, context } = fixture();
  invoice.lines = [{ ...invoice.lines[0], vendorItemCode: "EXP-PRINT" }];
  invoice.taxableTotal = invoice.lines[0].amount;
  context.receipts = [
    {
      kind: "GRPO",
      docEntry: 900,
      docNum: 990,
      lineNum: 0,
      cardCode: "V-PUBLISHER",
      itemCode: "EXP-PRINT",
      date: "2026-08-10",
      branchId: null,
      warehouse: null,
      poDocEntry: 880,
      poDocNum: 475,
      poLineNum: 0,
      poRefs: ["475"],
      quantity: 350,
      openQty: 350,
      price: 8.25,
      vehicle: null,
      vendorRef: invoice.invoiceNumber,
      eWayBill: null,
      lorryReceipt: null,
    },
  ];
  const result = evaluateMatch({ invoice, context });
  assert.equal(result.status, "ready");
  assert.equal(result.method, "3-way");
  assert.equal(result.lines[0].kind, "material");
  assert.equal(result.payload?.lines[0].baseType, 20);
  assert.equal(result.payload?.lines[0].baseEntry, 900);
});

test("unknown SAP inventory status does not authorize a non-stock PO bypass", () => {
  const { invoice, context, state } = fixture();
  context.items["EXP-PRINT"].inventory = null;
  const result = evaluateMatch({ invoice, context, state });
  assert.equal(result.status, "blocked");
  assert.equal(result.payload, null);
});

test("a second invoice line cannot reuse an exhausted PO line", () => {
  const { invoice, context, state } = fixture();
  state.allocations["2"] = { "880:0": invoice.lines[2].amount! };
  const result = evaluateMatch({ invoice, context, state });
  assert.equal(result.status, "blocked");
  assert.ok(!result.payload?.lines.some((line) => line.invoiceLineIndex === 2));
});

test("insufficient PO quantity blocks even when its value appears sufficient", () => {
  const { invoice, context, state } = fixture();
  context.poLines[0].openQty = 349;
  const result = evaluateMatch({ invoice, context, state });
  assert.equal(result.status, "blocked");
  assert.ok(result.open.some((check) => check.id === "qty-0"));
});

test("draft-time revalidation rejects stock/unknown items and accepts only the same SAP non-stock code", async () => {
  const { invoice, context, state, document } = fixture();
  const plan = evaluateMatch({ invoice, context, state }).payload!;
  const bases = new Map([["22:880", document]]);
  let reads = 0;
  await revalidateNonStockPoItems(plan, bases, async (code) => {
    reads++;
    return { ItemCode: code, InventoryItem: "tNO" };
  });
  assert.equal(reads, 1, "Revalidate each distinct item once");
  for (const status of ["tYES", undefined])
    await assert.rejects(
      () =>
        revalidateNonStockPoItems(plan, bases, async (code) => ({
          ItemCode: code,
          InventoryItem: status,
        })),
      /no longer confirms/,
    );
  await assert.rejects(
    () =>
      revalidateNonStockPoItems(plan, bases, async () => ({
        ItemCode: "OTHER",
        InventoryItem: "tNO",
      })),
    /no longer confirms/,
  );
});

test("non-stock price explanations use invoice units, not the allocated monetary amount", () => {
  const { invoice, context, state } = fixture();
  context.poLines[0].price = 9.25;
  const result = evaluateMatch({ invoice, context, state });
  const review = priceReviewDetails(invoice, result.lines[0], 0.5)!;
  assert.equal(review.valueDifference, 350);
  assert.equal(review.partialAllocation, false);
});

test("a saved item link that no PO line uses still lets the reviewer pick a PO line", () => {
  const { invoice, context } = fixture();
  invoice.lines = [invoice.lines[0]];
  invoice.poReferences = ["SIPL/475"];
  context.items["NINV1"] = { name: "Visiting Cards", inventory: false };
  context.itemMap[itemMappingKey(invoice.lines[0])!] = "NINV1";
  const open = evaluateMatch({ invoice, context });
  assert.equal(open.lines[0].kind, "non-stock");
  assert.equal(open.lines[0].candidates.length, 4);
  assert.ok(open.lines[0].candidates.every((entry) => entry.allocated === 0));
  const picked = evaluateMatch({
    invoice,
    context,
    state: {
      decisions: {},
      allocations: { "0": { "880:0": invoice.lines[0].amount! } },
    },
  });
  assert.equal(picked.lines[0].itemCode, "EXP-PRINT");
  assert.equal(picked.lines[0].po?.docNum, 475);
});
