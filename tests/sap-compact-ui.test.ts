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
import { evaluateMatch } from "../src/lib/sap-match/engine";
import { reviewModel } from "../src/lib/sap-match/review-model";

const outputDir = resolve("tmp/compact-ui-test");
mkdirSync(outputDir, { recursive: true });
buildSync({
  entryPoints: [
    "src/components/cases/sap-match/WhatGoesToSap.tsx",
    "src/components/cases/sap-match/CheckBlock.tsx",
    "src/components/cases/sap-match/MatchLineCard.tsx",
    "src/components/cases/sap-match/ReviewHeader.tsx",
    "src/components/cases/sap-match/RecordedInvoiceReview.tsx",
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
const { ReviewHeader } = requireComponent(
  resolve(outputDir, "ReviewHeader.js"),
);
const { RecordedInvoiceReview } = requireComponent(
  resolve(outputDir, "RecordedInvoiceReview.js"),
);

test("unmapped goods expose complete non-stock PO evidence without replacing the stock linker or inventing a PO-reference match", () => {
  const invoice = {
    ...matchFixture.invoice,
    supplyNature: "goods" as const,
    poReferences: ["REGION/475"],
    freightAmount: 0,
    taxableTotal: 1000,
    lines: [
      {
        ...matchFixture.invoice.lines[0],
        index: 0,
        vendorItemCode: null,
        description: "A4 printed publication",
        quantity: 10,
        rate: 100,
        amount: 1000,
      },
    ],
  };
  const context = {
    vendor: { cardCode: "V-PRINT", cardName: "Publisher" },
    ambiguousVendors: [],
    branch: null,
    items: { "EXP-PRINT": { name: "Marketing expense", inventory: false } },
    itemMap: {},
    itemMasterSuggestions: {
      "0": [
        {
          itemCode: "CATALOG-PRINT",
          name: "A4 printed publication",
          why: "Same name in SAP Item Master. Not proof of a supplier PO match; confirm before linking.",
        },
      ],
    },
    receipts: [],
    poLines: [
      {
        kind: "PO" as const,
        documentType: "dDocument_Items" as const,
        docEntry: 88,
        docNum: 475,
        lineNum: 0,
        cardCode: "V-PRINT",
        date: "2026-08-08",
        itemCode: "EXP-PRINT",
        branchId: null,
        warehouse: null,
        poRefs: ["475"],
        quantity: 10,
        openQty: 10,
        price: 100,
        lineTotal: 1000,
        openAmount: 1000,
        description: "Marketing expense",
        lineRemarks: "Publication RCP A4",
        headerRemarks: "August northern region",
      },
    ],
    existingInvoice: null,
    today: "2026-10-15",
    closedBefore: null,
  };
  const pending = evaluateMatch({ invoice, context });
  const props = {
    caseId: "po-review",
    invoice,
    locked: false,
    busy: false,
    vendorFound: true,
    onChoose: () => {},
    onUndo: () => {},
    onAllocate: () => {},
    onResetAllocation: () => {},
    onLink: () => {},
  };
  const html = renderToStaticMarkup(
    createElement(MatchLineCard, {
      ...props,
      line: pending.lines[0],
      checks: pending.checks,
    }),
  );
  for (const text of [
    "Search SAP items",
    "Found on this supplier’s purchase orders",
    "Found in SAP Item Master",
    "CATALOG-PRINT",
    "name match only",
    "Not proof of a supplier PO match",
    "Publication RCP A4",
    "August northern region",
    "REGION/475",
    "Open quantity",
    "Unit price",
    "Printed PO reference not confirmed",
  ])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes("Exact PO reference recorded"));
  const confirmed = evaluateMatch({
    invoice,
    context,
    state: { decisions: {}, allocations: { "0": { "88:0": 1000 } } },
  });
  const selected = renderToStaticMarkup(
    createElement(MatchLineCard, {
      ...props,
      line: confirmed.lines[0],
      checks: confirmed.checks,
    }),
  );
  assert.ok(selected.includes("non-stock item, invoice-to-PO check"));
  assert.ok(selected.includes("accounting item confirmed"));
  assert.ok(selected.includes("no reusable item mapping was saved"));
  assert.ok(!selected.includes("stock item, 3-way check"));
  assert.ok(!selected.includes("service, 2-way check"));

  // The known buyer prefix may narrow the view, but must not allocate a line.
  const prefixedInvoice = { ...invoice, poReferences: ["SIPL/475"] };
  const referenced = evaluateMatch({
    invoice: prefixedInvoice,
    context: {
      ...context,
      poLines: [
        ...context.poLines,
        { ...context.poLines[0], docNum: 476, docEntry: 89, poRefs: ["476"] },
      ],
    },
  });
  const pendingHtml = renderToStaticMarkup(
    createElement(MatchLineCard, {
      ...props,
      invoice: prefixedInvoice,
      line: referenced.lines[0],
      checks: referenced.checks,
    }),
  );
  const primary = pendingHtml.slice(0, pendingHtml.indexOf("<details"));
  assert.match(primary, /PO 475 found/);
  assert.match(primary, /SAP confirms these PO items are non-stock/);
  assert.match(primary, /Publication RCP A4/);
  assert.match(primary, /Open quantity/);
  assert.doesNotMatch(
    primary,
    /Search SAP items|Item not linked|None of the available PO candidates/,
  );
  assert.doesNotMatch(primary, /checked=""/);
  assert.doesNotMatch(primary, /Confirm PO line<\/button>/);
  const comparison = primary.slice(primary.indexOf("<table"));
  assert.match(comparison, /PO 475/);
  assert.doesNotMatch(comparison, /PO 476/);
  assert.equal(referenced.payload, null);
  assert.equal(referenced.lines[0].itemCode, null);
  const review = reviewModel(referenced, {
    invoice: prefixedInvoice,
    approved: false,
  });
  assert.equal(review.title, "PO found · Confirm invoice lines");
  assert.equal(review.ready, false);
  assert.deepEqual(review.waiting, ["PO line confirmation", "case approval"]);
  const withOtherBlock = {
    ...referenced,
    checks: [
      ...referenced.checks,
      {
        id: "extra",
        lineIndex: null,
        sev: "block" as const,
        open: true,
        title: "Another prerequisite",
      },
    ],
  };
  assert.equal(
    reviewModel(withOtherBlock, { invoice: prefixedInvoice, approved: false })
      .title,
    "Can't send yet",
  );
  const headerHtml = renderToStaticMarkup(
    createElement(ReviewHeader, {
      invoice: prefixedInvoice,
      vendor: context.vendor,
      result: referenced,
      unchecked: [],
      title: review.title,
      tone: review.tone,
      env: "test",
      busy: false,
      onRefresh() {},
    }),
  );
  assert.match(headerHtml, /Confirm PO item/);
  assert.match(headerHtml, /Purchase Order/);
  assert.match(headerHtml, /PO 475/);
  assert.doesNotMatch(headerHtml, /Needs items linked/);
});

function recordedProps(details = true) {
  const result = {
    ...matchFixture.result,
    status: "blocked" as const,
    lines: [],
    payload: null,
    existingInvoice: {
      kind: "invoice" as const,
      docNum: 551,
      ...(details
        ? {
            evidence: {
              docEntry: 77,
              docNum: 551,
              cardCode: "V-GIFT",
              invoiceReference: "GIFT-88",
              currency: "USD",
              total: 500,
              lines: [
                {
                  lineNum: 0,
                  itemCode: "EXP-24",
                  description: "Promotion expense",
                  accountCode: "AC-45",
                  quantity: 5,
                  unitPrice: 100,
                  lineTotal: 500,
                },
              ],
            },
          }
        : {}),
    },
    checks: [
      {
        id: "dup",
        lineIndex: null,
        sev: "block" as const,
        open: true,
        title: "Already in SAP as A/P Invoice 551",
        ask: "Close this invoice?",
        options: [
          {
            choice: "close",
            title: "Close, already in SAP",
            lines: ["Nothing is sent to SAP"],
            effect: "close" as const,
          },
        ],
      },
    ],
  };
  return {
    invoice: {
      ...matchFixture.invoice,
      invoiceNumber: "GIFT-88",
      currency: "USD",
      lines: [
        {
          ...matchFixture.invoice.lines[0],
          index: 0,
          vendorItemCode: null,
          description: "Coffee machine",
          quantity: 1,
          amount: 300,
        },
        {
          ...matchFixture.invoice.lines[0],
          index: 1,
          vendorItemCode: null,
          description: "Travel bags",
          quantity: 4,
          amount: 200,
        },
      ],
    },
    vendor: { cardCode: "V-GIFT", cardName: "Rewards Limited" },
    result,
    env: "test",
    busy: false,
    error: null,
    onRefresh: () => {},
    onChoose: () => {},
    onUndo: () => {},
  };
}

test("recorded review shows separate invoice products and SAP accounting lines, without new-match actions", () => {
  const html = renderToStaticMarkup(
    createElement(RecordedInvoiceReview, recordedProps()),
  );
  for (const text of [
    "Already in SAP",
    "A/P Invoice 551",
    "Coffee machine",
    "Travel bags",
    "Promotion expense",
    "EXP-24",
    "2 lines",
    "USD 500",
    "SAP keeps its own accounting description",
    "Close, already in SAP",
  ])
    assert.ok(html.includes(text), text);
  for (const text of [
    "Item not linked",
    "Select Item",
    "Search SAP items",
    "Allocate",
    "Create A/P Invoice Draft",
    "Go to approval",
    "Needs a match first",
    "Matched",
  ])
    assert.ok(!html.includes(text), text);
  assert.ok(!html.includes("<input"));
});

test("recorded review keeps duplicate protection visible when SAP detail reading fails", () => {
  const html = renderToStaticMarkup(
    createElement(RecordedInvoiceReview, recordedProps(false)),
  );
  assert.ok(html.includes("its item details are unavailable"));
  assert.ok(html.includes("Duplicate protection remains active"));
  assert.ok(html.includes("Close, already in SAP"));
  assert.ok(!html.includes("0 SAP lines"));
});

test("closed duplicates retain the historical comparison and a reversible decision, not draft actions", () => {
  const props = recordedProps();
  const result = {
    ...props.result,
    status: "closed",
    checks: props.result.checks.map((check) => ({
      ...check,
      decision: { choice: "close", effect: "close", at: "2026-10-15" },
    })),
  };
  const html = renderToStaticMarkup(
    createElement(RecordedInvoiceReview, { ...props, result }),
  );
  assert.ok(html.includes("Closed, already in SAP"));
  assert.ok(html.includes("Promotion expense"));
  assert.ok(html.includes("Change"));
  assert.ok(!html.includes("Create A/P Invoice Draft"));
});

test("service review compares the invoice with non-stock SAP PO items without claiming an automatic match", () => {
  const invoice = {
    ...matchFixture.invoice,
    supplyNature: "services" as const,
    poReferences: [],
    freightAmount: 0,
    taxableTotal: 1000,
    total: 1000,
    lines: [
      {
        index: 0,
        vendorItemCode: null,
        description: "Quarterly advisory",
        hsnSac: null,
        quantity: 2,
        unit: "Hours",
        rate: 500,
        amount: 1000,
      },
    ],
  };
  const context = {
    vendor: { cardCode: "V-1", cardName: "Advisory Ltd" },
    ambiguousVendors: [],
    branch: null,
    itemMap: {},
    items: { "ADV-HOUR": { name: "Advisory provision", inventory: false } },
    receipts: [],
    poLines: [
      {
        kind: "PO" as const,
        documentType: "dDocument_Items" as const,
        docEntry: 7,
        docNum: 70,
        lineNum: 0,
        date: null,
        cardCode: "V-1",
        itemCode: "ADV-HOUR",
        branchId: null,
        warehouse: null,
        poRefs: ["70"],
        quantity: 10,
        openQty: 10,
        price: 500,
        lineTotal: 5000,
        openAmount: 5000,
      },
    ],
    existingInvoice: null,
    today: "2026-10-14",
    closedBefore: null,
  };
  const pending = evaluateMatch({ invoice, context });
  const props = {
    caseId: "service-ui",
    invoice,
    locked: false,
    busy: false,
    vendorFound: true,
    onChoose: () => {},
    onUndo: () => {},
    onAllocate: () => {},
    onResetAllocation: () => {},
    onLink: () => {},
  };
  const html = renderToStaticMarkup(
    createElement(MatchLineCard, {
      ...props,
      line: pending.lines[0],
      checks: pending.open,
    }),
  );
  assert.ok(html.includes("From the invoice"));
  assert.ok(html.includes("Quarterly advisory"));
  assert.ok(html.includes("From SAP"));
  assert.ok(html.includes("ADV-HOUR"));
  assert.ok(html.includes("Advisory provision"));
  assert.ok(html.includes("Non-stock item"));
  assert.ok(html.includes("Confirm the correct service PO line"));
  assert.ok(!html.includes("No open PO for this service"));
  assert.ok(!html.includes("SAP GRPO"));
  const header = renderToStaticMarkup(
    createElement(ReviewHeader, {
      invoice,
      vendor: context.vendor,
      result: pending,
      unchecked: [],
      title: "Can't send yet",
      tone: "bad",
      env: "test",
      onRefresh: () => {},
      busy: false,
    }),
  );
  assert.ok(header.includes("Confirm PO item"));
  assert.ok(header.includes("Choose PO"));
  const candidate = pending.lines[0].candidates[0];
  const confirmed = evaluateMatch({
    invoice,
    context,
    state: { decisions: {}, allocations: { "0": { [candidate.key]: 1000 } } },
  });
  const confirmedHtml = renderToStaticMarkup(
    createElement(MatchLineCard, {
      ...props,
      line: confirmed.lines[0],
      checks: [],
    }),
  );
  assert.ok(confirmedHtml.includes("Matched"));
  assert.ok(confirmedHtml.includes("Change PO line"));
  assert.ok(confirmedHtml.includes("View matching details"));
  assert.ok(!confirmedHtml.includes('type="radio"'));
  assert.ok(!confirmedHtml.includes("Service PO lines"));
  assert.ok(confirmedHtml.includes("From the invoice"));
  assert.ok(confirmedHtml.includes("From SAP · PO 70"));
  assert.ok(confirmedHtml.includes("Billing units"));
  assert.ok(confirmedHtml.includes("Unit price"));

  const lockedHtml = renderToStaticMarkup(
    createElement(MatchLineCard, {
      ...props,
      locked: true,
      line: confirmed.lines[0],
      checks: [],
    }),
  );
  assert.ok(!lockedHtml.includes("Change PO line"));
  assert.ok(!lockedHtml.includes('type="radio"'));

  const serviceContext = {
    ...context,
    poLines: context.poLines.map((line) => ({
      ...line,
      documentType: "dDocument_Service" as const,
      itemCode: "",
      accountCode: "ACCOUNT-1",
      description: "Quarterly advisory",
    })),
  };
  const serviceInvoice = { ...invoice, poReferences: ["70"] };
  const serviceResult = evaluateMatch({
    invoice: serviceInvoice,
    context: serviceContext,
  });
  const serviceHtml = renderToStaticMarkup(
    createElement(MatchLineCard, {
      ...props,
      invoice: serviceInvoice,
      line: serviceResult.lines[0],
      checks: serviceResult.open,
    }),
  );
  assert.ok(!serviceHtml.includes("Billing units"));
  assert.ok(!serviceHtml.includes("Unit price"));
  assert.ok(serviceHtml.includes("Matched"));
  const draftHtml = renderToStaticMarkup(
    createElement(WhatGoesToSap, {
      invoice: serviceInvoice,
      result: serviceResult,
      lines: serviceResult.lines,
      vendorLabel: "Advisory Ltd",
    }),
  );
  assert.ok(draftHtml.includes("Quarterly advisory"));
  assert.ok(!draftHtml.includes(">Quantity<"));
  assert.ok(!draftHtml.includes(">Unit price<"));
});

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
  assert.ok(
    rows.some((row) => /GRPO 718: .*lorry receipt.*Blank in SAP/.test(row)),
    rows.join("|"),
  );
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
  assert.match(
    missingNote ?? "",
    /GRPO 718: reference values were not recorded/,
  );
  assert.ok(
    rows.some((row) => /different truck \(OTHER\)/.test(row)),
    rows.join("|"),
  );
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
  assert.match(html, /Calculated by SAP/);
  const afterSheet = html.slice(html.lastIndexOf("</details>"));
  assert.doesNotMatch(afterSheet, /Matches invoice/);
  assert.match(afterSheet, /Create draft/);
});
