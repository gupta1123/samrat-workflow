import {
  DEFAULT_MATCH_RULES,
  EMPTY_MATCH_STATE,
  type CandidateView,
  type CheckEffect,
  type CheckOption,
  type LineResult,
  type MatchCheck,
  type MatchContext,
  type MatchInvoice,
  type MatchInvoiceLine,
  type MatchResult,
  type MatchRules,
  type MatchState,
  type MatchStatus,
  type PlannedDocumentLine,
  type PlannedPayload,
  type SapPoLine,
  type SapReceiptLine,
} from "./types";

const EPS = 0.0005;
/** SAP and vendors round differently; up to this per document is treated as rounding. */
export const DOCUMENT_ROUNDING = 10;
const MIN_FIRST_SCORE = 35;

export function normalizeRef(value: unknown): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** Key under which a vendor's item is remembered in the item-mapping table. */
export function itemMappingKey(line: {
  vendorItemCode?: string | null;
  description?: string | null;
}): string | null {
  const code = normalizeRef(line.vendorItemCode);
  if (code) return code;
  const description = normalizeRef(line.description);
  return description ? `D:${description}` : null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const inr = (n: number) =>
  `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Math.abs(n))}`;
const qty = (n: number) => (Math.round(n * 1000) / 1000).toString();

function daysBetween(from: string, to: string) {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() -
      new Date(`${from}T00:00:00Z`).getTime()) /
      86_400_000,
  );
}

function receiptKey(line: { docEntry: number; lineNum: number }) {
  return `${line.docEntry}:${line.lineNum}`;
}

function tokens(value: string) {
  return new Set(
    value
      .toUpperCase()
      .split(/[^A-Z0-9.]+/)
      .filter((token) => token.length > 1),
  );
}

type CheckDraft = Omit<MatchCheck, "open" | "decision">;

class Checks {
  private readonly all: MatchCheck[] = [];
  constructor(private readonly state: MatchState) {}

  push(draft: CheckDraft) {
    const saved = this.state.decisions[draft.id];
    const option = saved
      ? draft.options?.find((candidate) => candidate.choice === saved.choice)
      : undefined;
    // A decision that needs a reason is not accepted without one.
    const usable =
      saved && option && (!option.needsReason || (saved.reason ?? "").trim());
    if (!usable || !option) {
      this.all.push({ ...draft, open: draft.sev !== "pass" });
      return;
    }
    const decision = { ...saved, effect: option.effect };
    if (option.effect === "resolve" || option.effect === "use-today") {
      this.all.push({ ...draft, decision, open: false });
    } else if (option.effect === "hold" || option.effect === "stores") {
      this.all.push({
        ...draft,
        sev: "wait",
        options: undefined,
        title:
          option.effect === "stores"
            ? `Waiting for stores to correct the receipt`
            : `On hold: ${draft.title}`,
        waitNote:
          option.effect === "stores"
            ? "Nothing to do now. Stores re-weighs and corrects the goods receipt in SAP; this re-checks automatically."
            : "On hold until more material is received or the vendor corrects the invoice.",
        decision,
        open: true,
      });
    } else {
      // return / close: terminal for this invoice
      this.all.push({ ...draft, decision, open: true });
    }
  }

  list() {
    return this.all;
  }
}

export type EvaluateInput = {
  invoice: MatchInvoice;
  context: MatchContext;
  rules?: Partial<MatchRules>;
  state?: MatchState;
};

function scoreReceipt(
  invoice: MatchInvoice,
  line: MatchInvoiceLine,
  receipt: SapReceiptLine,
  rules: MatchRules,
  open: number,
) {
  const good: string[] = [];
  const bad: string[] = [];
  let score = 0;
  let truck = false;
  const exact = (left: unknown, right: unknown) => {
    const a = normalizeRef(left);
    const b = normalizeRef(right);
    return Boolean(a && b && a === b);
  };
  const invoicePos = invoice.poReferences.map(normalizeRef).filter(Boolean);
  const receiptPos = receipt.poRefs.map(normalizeRef).filter(Boolean);
  if (invoicePos.length && receiptPos.some((ref) => invoicePos.includes(ref))) {
    score += 40;
    good.push("same PO");
  } else if (receiptPos.length) {
    bad.push(`different PO (${receipt.poRefs[0]})`);
  }
  const vendorRef = normalizeRef(receipt.vendorRef);
  if (vendorRef) {
    if (vendorRef === normalizeRef(invoice.invoiceNumber)) {
      score += 35;
      truck = true;
      good.push("stores wrote this invoice number on it");
    } else {
      score -= 30;
      bad.push(`stores linked it to another invoice (${receipt.vendorRef})`);
    }
  }
  if (receipt.eWayBill) {
    if (exact(receipt.eWayBill, invoice.eWayBill)) {
      score += 40;
      truck = true;
      good.push("same e-way bill");
    } else if (invoice.eWayBill) {
      score -= 30;
      bad.push(`different e-way bill (${receipt.eWayBill})`);
    }
  }
  if (receipt.lorryReceipt) {
    if (exact(receipt.lorryReceipt, invoice.lorryReceipt)) {
      score += 35;
      truck = true;
      good.push("same lorry receipt");
    } else if (invoice.lorryReceipt) {
      score -= 25;
      bad.push(`different lorry receipt (${receipt.lorryReceipt})`);
    }
  }
  const vehicle = normalizeRef(receipt.vehicle);
  if (vehicle) {
    if (invoice.vehicles.map(normalizeRef).includes(vehicle)) {
      score += 25;
      truck = true;
      good.push(`same truck (${receipt.vehicle})`);
    } else {
      bad.push(`different truck (${receipt.vehicle})`);
    }
  }
  if (line.quantity !== null) {
    const difference = Math.abs(open - line.quantity);
    if (difference < EPS) {
      score += 15;
      good.push("same quantity");
    } else if ((difference / line.quantity) * 100 <= rules.qtyTolerancePct) {
      score += 8;
    }
  }
  if (invoice.invoiceDate && receipt.date) {
    const days = daysBetween(invoice.invoiceDate, receipt.date);
    if (days >= 0 && days <= rules.receiptWindowDays) score += 10;
    else if (days < 0) bad.push("received before the invoice date");
  }
  return {
    score: Math.max(0, Math.min(100, Math.round((score / 125) * 100))),
    good,
    bad,
    truck,
  };
}

function candidateView(
  key: string,
  kind: "GRPO" | "PO",
  source: SapReceiptLine | SapPoLine,
  open: number,
): CandidateView {
  return {
    key,
    kind,
    docNum: source.docNum,
    docEntry: source.docEntry,
    lineNum: source.lineNum,
    date: source.date,
    poRef: source.poRefs[0] ?? null,
    vehicle: "vehicle" in source ? source.vehicle : null,
    quantity: source.quantity,
    open,
    price: source.price,
    score: 0,
    good: [],
    bad: [],
    rejected: null,
    allocated: 0,
    note: "note" in source ? (source.note ?? null) : null,
  };
}

function suggestItems(
  line: MatchInvoiceLine,
  context: MatchContext,
  invoice: MatchInvoice,
): Array<{ itemCode: string; name: string; why: string }> {
  const exact = (left: unknown, right: unknown) => {
    const a = normalizeRef(left);
    const b = normalizeRef(right);
    return Boolean(a && b && a === b);
  };
  const fromReceipt = context.receipts
    .flatMap((receipt) => {
      const reasons: string[] = [];
      if (exact(receipt.vendorRef, invoice.invoiceNumber)) reasons.push(`receipt ${receipt.docNum} has the same invoice number`);
      if (exact(receipt.eWayBill, invoice.eWayBill)) reasons.push(`receipt ${receipt.docNum} has the same e-way bill`);
      if (exact(receipt.lorryReceipt, invoice.lorryReceipt)) reasons.push(`receipt ${receipt.docNum} has the same lorry receipt`);
      if (!reasons.length) return [];
      if (line.quantity !== null && Math.abs(receipt.openQty - line.quantity) < EPS) {
        reasons.push("quantity also matches");
      }
      const info = context.items[receipt.itemCode];
      return [{
        itemCode: receipt.itemCode,
        name: info?.name ?? receipt.itemCode,
        why: reasons.join("; "),
      }];
    });
  const anchored = [...new Map(fromReceipt.map((entry) => [entry.itemCode, entry])).values()];
  if (anchored.length) return anchored.slice(0, 3);

  const wanted = tokens(`${line.description ?? ""} ${line.vendorItemCode ?? ""}`);
  if (!wanted.size) return [];
  return Object.entries(context.items)
    .map(([itemCode, info]) => {
      const have = tokens(`${info.name} ${itemCode}`);
      let common = 0;
      for (const token of wanted) if (have.has(token)) common += 1;
      return { itemCode, name: info.name, common };
    })
    .filter((entry) => entry.common >= 2)
    .sort((a, b) => b.common - a.common)
    .slice(0, 3)
    .map((entry) => ({
      itemCode: entry.itemCode,
      name: entry.name,
      why: `${entry.common} matching words in the description`,
    }));
}

function stateCode(gstin: string | null) {
  const code = (gstin ?? "").trim().slice(0, 2);
  return /^\d{2}$/.test(code) ? code : null;
}

const RETURN_OPTION: CheckOption = {
  choice: "return",
  title: "Return to vendor",
  lines: ["Ask the vendor for a corrected invoice"],
  effect: "return",
};

export function evaluateMatch(input: EvaluateInput): MatchResult {
  const rules: MatchRules = { ...DEFAULT_MATCH_RULES, ...input.rules };
  const state = input.state ?? EMPTY_MATCH_STATE;
  const { invoice, context } = input;
  const checks = new Checks(state);
  const lineResults: LineResult[] = [];
  const planned: PlannedDocumentLine[] = [];

  // ---- Invoice-level checks ----
  if (context.existingInvoice) {
    checks.push({
      id: "dup",
      lineIndex: null,
      sev: "block",
      ask: "Close this invoice?",
      title:
        context.existingInvoice.kind === "draft"
          ? `Already in SAP as an A/P invoice draft (${context.existingInvoice.docNum})`
          : `Already in SAP as A/P invoice ${context.existingInvoice.docNum}`,
      help: "Posting it again would pay the vendor twice.",
      options: [
        {
          choice: "close",
          title: "Close as duplicate",
          lines: ["Nothing is sent to SAP", "Documents stay on file"],
          effect: "close",
          recommended: true,
        },
      ],
    });
  } else {
    checks.push({ id: "dup", lineIndex: null, sev: "pass", title: "Not billed before in SAP" });
  }

  if (!context.vendor) {
    const read = context.suppliersRead;
    checks.push({
      id: "vendor",
      lineIndex: null,
      sev: "block",
      title: context.ambiguousVendors.length
        ? "More than one exact SAP vendor record matches this invoice"
        : "No SAP vendor found for this invoice",
      help: context.ambiguousVendors.length
        ? `SAP has multiple records with the invoice's exact GSTIN or vendor name. Choose the correct SAP vendor code below; no vendor has been guessed.`
        : read === 0
          ? `SAP returned no suppliers at all for the connected user, so nothing could be compared with "${invoice.vendorName ?? "unknown"}". Check that the SAP user may read business partners.`
          : `No exact GSTIN or vendor-name match was found for "${invoice.vendorName ?? "unknown"}" among ${read ?? "the"} SAP suppliers. Search SAP and explicitly choose the correct vendor; the system will not guess.`,
      vendorSuggestions: context.ambiguousVendors.length
        ? context.ambiguousVendors
        : [],
      vendorKey: context.vendorKey ?? null,
    });
  } else {
    checks.push({
      id: "vendor",
      lineIndex: null,
      sev: "pass",
      title: `Vendor: ${context.vendor.cardName} (${context.vendor.cardCode})`,
    });
  }

  checks.push({
    id: "branch",
    lineIndex: null,
    sev: "pass",
    title: context.branch
      ? `Branch: ${context.branch.name}`
      : "Branch not checked (no branch is saved for this ship-to state)",
  });

  // GST type against vendor and ship-to state.
  const vendorState = stateCode(invoice.vendorGstin);
  const shipState = stateCode(invoice.shipToGstin) ?? context.branch?.stateCode ?? null;
  if (vendorState && shipState && invoice.taxCharged !== "unknown") {
    const expected = vendorState === shipState ? "split" : "igst";
    if (expected !== invoice.taxCharged) {
      checks.push({
        id: "tax",
        lineIndex: null,
        sev: "block",
        ask: "Send it back for a corrected invoice?",
        title: `Wrong GST: ${invoice.taxCharged === "igst" ? "IGST" : "CGST + SGST"} charged, ${expected === "igst" ? "IGST" : "CGST + SGST"} expected`,
        help: `Supplied from state ${vendorState} to state ${shipState}. ${expected === "split" ? "Same state, so CGST + SGST applies." : "Different states, so IGST applies."} Tax credit cannot be claimed on this invoice as it is.`,
        options: [{ ...RETURN_OPTION, recommended: true, lines: ["Ask for a credit note and a corrected invoice"] }],
      });
    } else {
      checks.push({ id: "tax", lineIndex: null, sev: "pass", title: "GST type is correct" });
    }
  } else {
    checks.push({
      id: "tax",
      lineIndex: null,
      sev: "pass",
      title: "GST type could not be verified from the GSTINs",
    });
  }

  // Posting date and closed period.
  const usesToday =
    rules.postingDate === "today" ||
    Object.entries(state.decisions).some(
      ([id, decision]) => id === "period" && decision.choice === "use-today",
    );
  const docDate = usesToday ? context.today : (invoice.invoiceDate ?? context.today);
  if (context.closedBefore && docDate < context.closedBefore) {
    checks.push({
      id: "period",
      lineIndex: null,
      sev: "block",
      ask: "Book it in the current month instead?",
      title: `${docDate.slice(0, 7)} is already closed in SAP`,
      help: `The booking date would be ${docDate}. Book it today instead; the GST date stays ${invoice.invoiceDate ?? "as printed"}.`,
      options: [
        {
          choice: "use-today",
          title: `Book on ${context.today}`,
          lines: ["GST date unchanged", "Only the booking date moves"],
          effect: "use-today",
          recommended: true,
        },
      ],
    });
  } else {
    checks.push({ id: "period", lineIndex: null, sev: "pass", title: "Booking month is open" });
  }

  // ---- Lines ----
  const totalQty = sum(invoice.lines.map((line) => line.quantity ?? 0));
  let bookedQtyTotal = 0;

  for (const ln of invoice.lines) {
    const mappingKey = itemMappingKey(ln);
    const mapped = mappingKey ? context.itemMap[mappingKey] : undefined;
    const directCode = ln.vendorItemCode ? normalizeRef(ln.vendorItemCode) : "";
    const itemCode =
      mapped ??
      Object.keys(context.items).find((code) => normalizeRef(code) === directCode) ??
      null;
    const info = itemCode ? context.items[itemCode] : null;
    const result: LineResult = {
      index: ln.index,
      kind: "unmapped",
      itemCode,
      itemName: info?.name ?? null,
      invoiceQty: ln.quantity,
      invoiceRate: ln.rate,
      invoiceAmount: ln.amount,
      candidates: [],
      allocatedQty: 0,
      manual: false,
      po: null,
    };
    lineResults.push(result);

    if (!itemCode) {
      checks.push({
        id: `map-${ln.index}`,
        lineIndex: ln.index,
        sev: "block",
        title: `Item not linked: ${ln.description ?? ln.vendorItemCode ?? `line ${ln.index + 1}`}`,
        help: `${invoice.vendorName ?? "This vendor"}'s material ${ln.vendorItemCode ?? ""} is not linked to one of your SAP items yet. Link it once and future invoices use it automatically.`,
        itemSuggestions: suggestItems(ln, context, invoice),
      });
      continue;
    }
    checks.push({
      id: `map-${ln.index}`,
      lineIndex: ln.index,
      sev: "pass",
      title: `Item recognised: ${info?.name ?? itemCode}`,
    });
    if (!context.vendor) continue;

    const isService = info?.inventory === false;
    result.kind = isService ? "service" : "material";
    if (isService) {
      evaluateServiceLine({ ln, itemCode, result, invoice, context, state, checks, planned });
    } else {
      bookedQtyTotal += evaluateMaterialLine({
        ln,
        itemCode,
        result,
        invoice,
        context,
        rules,
        state,
        checks,
        planned,
        totalQty,
      });
    }
  }

  // ---- Freight and totals ----
  const freight = invoice.freightAmount;
  let freightExpense: number | null = null;
  let freightExcluded = 0;
  if (freight > 0) {
    if (rules.freightPolicy === "separate") {
      freightExcluded = freight;
      checks.push({
        id: "freight",
        lineIndex: null,
        sev: "ack",
        ask: "Pay freight separately?",
        title: `Freight ${inr(freight)} will be left out of this invoice`,
        help: "Your rule says freight is paid separately against a freight PO.",
        options: [
          {
            choice: "ok",
            title: "Yes, pay freight separately",
            lines: ["The transporter's bill is matched on its own"],
            effect: "resolve",
            recommended: true,
          },
        ],
      });
    } else if (rules.freightPolicy === "expense") {
      freightExpense = r2(totalQty > 0 ? (freight * bookedQtyTotal) / totalQty : freight);
      checks.push({
        id: "freight",
        lineIndex: null,
        sev: "pass",
        title: "Freight booked as a freight charge",
      });
    } else {
      checks.push({
        id: "freight",
        lineIndex: null,
        sev: "pass",
        title: "Freight added into the material cost",
      });
    }
  }

  const bookedTaxable = r2(
    sum(
      planned.map((line) =>
        line.lineTotal !== null
          ? line.lineTotal
          : line.quantity * (line.unitPrice ?? baseRateOf(line, context) ?? 0),
      ),
    ) + (freightExpense ?? 0),
  );
  const invoiceTaxable =
    invoice.taxableTotal ??
    (invoice.lines.some((line) => line.amount !== null)
      ? r2(sum(invoice.lines.map((line) => line.amount ?? 0)) + freight)
      : null);
  // The total is only comparable once every invoice line has something booked against it.
  const everyLinePlanned =
    invoice.lines.length > 0 &&
    new Set(planned.map((line) => line.invoiceLineIndex)).size === invoice.lines.length;
  // A quantity shortfall already has its own check; do not repeat it as a total difference.
  const shortReceipt = lineResults.some(
    (line) =>
      line.kind === "material" &&
      line.invoiceQty !== null &&
      line.allocatedQty > 0 &&
      line.allocatedQty < line.invoiceQty - EPS,
  );
  const difference =
    invoiceTaxable !== null && everyLinePlanned && !shortReceipt
      ? r2(invoiceTaxable - bookedTaxable - freightExcluded)
      : null;
  if (difference !== null && Math.abs(difference) > DOCUMENT_ROUNDING) {
    checks.push({
      id: "total",
      lineIndex: null,
      sev: "confirm",
      ask: "The SAP invoice would differ from the vendor's bill. Continue?",
      title: `The SAP invoice would be ${inr(Math.abs(difference))} ${difference > 0 ? "less" : "more"} than the vendor's bill (before tax)`,
      help: "This is more than rounding. Check the invoice lines, or confirm with a reason.",
      options: [
        { choice: "confirm", title: "Continue anyway", lines: ["Record the reason in the audit trail"], effect: "resolve", needsReason: true },
        RETURN_OPTION,
      ],
    });
  } else if (everyLinePlanned && !shortReceipt) {
    checks.push({ id: "total", lineIndex: null, sev: "pass", title: "SAP invoice total agrees with the vendor's bill" });
  }

  // ---- Status ----
  const all = checks.list();
  const open = all
    .filter((check) => check.open)
    .sort((a, b) => severityOrder(a.sev) - severityOrder(b.sev));
  let status: MatchStatus;
  const decisions = all.flatMap((check) => (check.decision ? [check.decision.effect] : []));
  if (decisions.includes("close")) status = "closed";
  else if (decisions.includes("return")) status = "returned";
  else if (open.some((check) => check.sev === "block")) status = "blocked";
  else if (open.some((check) => check.sev === "wait")) status = "waiting";
  else if (open.length) status = "review";
  else status = "ready";

  const baseDocuments = [
    ...new Map(
      planned.map((line) => [
        `${line.baseType}:${line.baseEntry}`,
        {
          kind: line.baseType === 20 ? ("GRPO" as const) : ("PO" as const),
          docNum: line.baseDocNum,
          docEntry: line.baseEntry,
        },
      ]),
    ).values(),
  ];
  const kinds = new Set(lineResults.map((line) => line.kind));
  const method: MatchResult["method"] =
    kinds.has("unmapped") || !lineResults.length
      ? "unknown"
      : kinds.size > 1
        ? "mixed"
        : kinds.has("service")
          ? "2-way"
          : "3-way";

  const payload: PlannedPayload | null =
    context.vendor && planned.length
      ? {
          cardCode: context.vendor.cardCode,
          numAtCard: invoice.invoiceNumber,
          docDate,
          taxDate: invoice.invoiceDate ?? docDate,
          branchId: context.branch?.bplId ?? null,
          comments: `Invoice ${invoice.invoiceNumber} · ${baseDocuments.map((doc) => `${doc.kind === "GRPO" ? "Receipt" : "PO"} ${doc.docNum}`).join(", ")}`,
          lines: planned,
          freightExpense,
          freightExcluded,
          bookedTaxable,
          invoiceTaxable,
          difference,
        }
      : null;

  return {
    status,
    checks: all,
    open,
    lines: lineResults,
    payload,
    baseDocuments,
    method,
    summary: summarize(status, open),
    postingDate: docDate,
  };
}

function severityOrder(sev: MatchCheck["sev"]) {
  return { block: 0, wait: 1, confirm: 2, ack: 3, pass: 4 }[sev];
}

function summarize(status: MatchStatus, open: MatchCheck[]) {
  switch (status) {
    case "ready":
      return "Everything matches";
    case "returned":
      return "Sent back to the vendor for correction";
    case "closed":
      return "Closed as duplicate";
    default:
      return open[0]?.title ?? "Needs review";
  }
}

function baseRateOf(line: PlannedDocumentLine, context: MatchContext): number | null {
  if (line.baseType === 20) {
    return (
      context.receipts.find(
        (receipt) => receipt.docEntry === line.baseEntry && receipt.lineNum === line.baseLine,
      )?.price ?? null
    );
  }
  return (
    context.poLines.find(
      (po) => po.docEntry === line.baseEntry && po.lineNum === line.baseLine,
    )?.price ?? null
  );
}

// ---------------------------------------------------------------------------
// Stock (3-way) lines
// ---------------------------------------------------------------------------

function poForReceipt(receipt: SapReceiptLine, context: MatchContext) {
  if (receipt.poDocEntry === null) return null;
  return (
    context.poLines.find(
      (po) => po.docEntry === receipt.poDocEntry && po.lineNum === receipt.poLineNum,
    ) ?? null
  );
}

function effectiveRate(ln: MatchInvoiceLine): number | null {
  // A printed unit rate is authoritative. A conflicting line amount can be a
  // subtotal, freight-inclusive value, extraction defect, or genuine business
  // mismatch; it is never proof of an unprinted discount rate.
  return ln.rate;
}

function evaluateMaterialLine(args: {
  ln: MatchInvoiceLine;
  itemCode: string;
  result: LineResult;
  invoice: MatchInvoice;
  context: MatchContext;
  rules: MatchRules;
  state: MatchState;
  checks: Checks;
  planned: PlannedDocumentLine[];
  totalQty: number;
}): number {
  const { ln, itemCode, result, invoice, context, rules, state, checks, planned, totalQty } = args;
  const i = ln.index;
  const vendor = context.vendor!;
  const billed = ln.quantity ?? 0;

  const candidates = context.receipts
    .filter((receipt) => receipt.cardCode === vendor.cardCode && receipt.itemCode === itemCode)
    .map((receipt) => {
      const view = candidateView(receiptKey(receipt), "GRPO", receipt, r3(receipt.openQty));
      if (view.open <= EPS) {
        view.rejected = `Already billed${receipt.invoicedBy ? ` (${receipt.invoicedBy})` : ""}`;
        return { view, receipt, truck: false };
      }
      const branch = context.branch;
      if (
        branch?.bplId != null &&
        receipt.branchId != null &&
        branch.bplId !== receipt.branchId
      ) {
        view.rejected = `Received at another branch, not ${branch.name}`;
        return { view, receipt, truck: false };
      }
      const scored = scoreReceipt(invoice, ln, receipt, rules, view.open);
      view.score = scored.score;
      view.good = scored.good;
      view.bad = scored.bad;
      return { view, receipt, truck: scored.truck };
    });

  const manual = state.allocations[String(i)];
  let remaining = billed;
  if (manual) {
    result.manual = true;
    for (const candidate of candidates) {
      const chosen = manual[candidate.view.key];
      if (!candidate.view.rejected && chosen != null) {
        candidate.view.allocated = r3(Math.min(Math.max(0, chosen), candidate.view.open));
      }
    }
  } else {
    const eligible = candidates
      .filter((candidate) => !candidate.view.rejected)
      .sort(
        (a, b) =>
          b.view.score - a.view.score ||
          (a.view.date ?? "").localeCompare(b.view.date ?? ""),
      );
    let taken = 0;
    for (const candidate of eligible) {
      if (remaining <= EPS) break;
      if (taken === 0 && candidate.view.score < MIN_FIRST_SCORE) break;
      if (taken > 0 && !candidate.truck) continue;
      candidate.view.allocated = r3(Math.min(candidate.view.open, remaining));
      remaining = r3(remaining - candidate.view.allocated);
      taken += 1;
    }
  }
  result.candidates = candidates.map((candidate) => candidate.view);
  const selected = candidates.filter((candidate) => candidate.view.allocated > 0);
  result.allocatedQty = r3(sum(selected.map((candidate) => candidate.view.allocated)));

  const vendorName = invoice.vendorName ?? "The vendor";
  const branchName = context.branch?.name ?? "this branch";

  if (result.allocatedQty <= 0) {
    const openPo = context.poLines.find(
      (po) =>
        po.cardCode === vendor.cardCode &&
        po.itemCode === itemCode &&
        po.openQty > EPS &&
        (!invoice.poReferences.length ||
          po.poRefs.some((ref) => invoice.poReferences.map(normalizeRef).includes(normalizeRef(ref)))),
    );
    if (openPo && !manual) {
      result.po = { docNum: openPo.docNum, ref: openPo.poRefs[0] ?? null, qty: openPo.quantity, rate: openPo.price };
      checks.push({
        id: `rcpt-${i}`,
        lineIndex: i,
        sev: "wait",
        title: `The truck${invoice.vehicles.length ? ` ${invoice.vehicles.join(", ")}` : ""} has not been received yet`,
        help: "Stores must record the receipt in SAP before a stock invoice can be paid. Otherwise SAP would add stock nobody checked.",
        waitNote: `Nothing to do now. Re-check when ${branchName} stores records it.`,
      });
    } else {
      checks.push({
        id: `rcpt-${i}`,
        lineIndex: i,
        sev: "block",
        title: manual ? "No receipt selected" : "No receipt found for this invoice",
        help: manual
          ? "You removed every receipt. Pick one below, or go back to the automatic match."
          : `Stores has no open receipt for ${result.itemName ?? itemCode} that this invoice could be paid against.`,
        options: manual
          ? [{ choice: "reset", title: "Go back to the automatic match", lines: ["Use the receipt we suggested"], effect: "resolve", recommended: true }]
          : [RETURN_OPTION],
      });
    }
    return 0;
  }

  const nos = selected.map((candidate) => candidate.view.docNum).join(" + ");
  checks.push({
    id: `rcpt-${i}`,
    lineIndex: i,
    sev: "pass",
    title: selected.length > 1 ? `Split across ${selected.length} receipts (${nos})` : `Matched to receipt ${nos}`,
  });

  // The receipt was matched by PO and quantity only, without any truck or invoice reference.
  const anchored = selected.some((candidate) => candidate.truck);
  if (!anchored) {
    checks.push({
      id: `anchor-${i}`,
      lineIndex: i,
      sev: "ack",
      ask: "Is this the right receipt?",
      title: "Matched on PO and quantity only",
      help: "The receipt has no truck number or invoice number that confirms it belongs to this invoice. Confirm it is the right one.",
      options: [
        { choice: "ok", title: "Yes, this receipt is right", lines: [`Receipt ${nos}`], effect: "resolve", recommended: true },
        RETURN_OPTION,
      ],
    });
  }

  const first = selected[0];
  const po = poForReceipt(first.receipt, context);
  const poQty = po?.quantity ?? null;
  const poRate = po?.price ?? first.receipt.price;
  result.po = {
    docNum: po?.docNum ?? first.receipt.poDocNum,
    ref: first.receipt.poRefs[0] ?? null,
    qty: poQty,
    rate: poRate,
  };

  // Quantity
  const diff = r3(billed - result.allocatedQty);
  if (diff < -EPS) {
    checks.push({
      id: `qty-${i}`,
      lineIndex: i,
      sev: "block",
      title: "More selected than billed",
      help: `You selected ${qty(result.allocatedQty)} but the invoice is for ${qty(billed)}.`,
      options: [{ choice: "reset", title: "Go back to the automatic match", lines: ["Selects exactly what was billed"], effect: "resolve", recommended: true }],
    });
  } else if (Math.abs(diff) <= EPS) {
    checks.push({ id: `qty-${i}`, lineIndex: i, sev: "pass", title: "Quantity billed = quantity received" });
  } else {
    const pct = (diff / result.allocatedQty) * 100;
    const overPo = poQty !== null && billed > poQty + EPS;
    if (pct <= rules.qtyTolerancePct) {
      checks.push({
        id: `qty-${i}`,
        lineIndex: i,
        sev: "ack",
        ask: `How should the ${qty(diff)} extra be settled?`,
        title: `${vendorName} billed ${qty(diff)} more than was received`,
        help: `${pct.toFixed(2)}% is inside your ${rules.qtyTolerancePct}% limit, but SAP can only be invoiced for what stores received. Ask stores to re-check the weight, or return the invoice.`,
        options: [
          { choice: "stores", title: "Stores re-weighs", lines: [`If ${qty(billed)} really arrived, stores corrects the receipt`, "The invoice waits until they do"], effect: "stores", recommended: true },
          RETURN_OPTION,
        ],
      });
    } else {
      checks.push({
        id: `qty-${i}`,
        lineIndex: i,
        sev: "block",
        ask: "What should happen to this invoice?",
        title: `${vendorName} billed ${qty(diff)} that never arrived`,
        help: `Only ${qty(result.allocatedQty)} was received, ${pct.toFixed(0)}% less than billed and above your ${rules.qtyTolerancePct}% limit.${overPo ? ` The PO is also only for ${qty(poQty!)}.` : ""}`,
        options: [
          { ...RETURN_OPTION, recommended: true, lines: [`Ask for a corrected invoice for ${qty(result.allocatedQty)}`] },
          { choice: "hold", title: "Hold for more receipts", lines: [`Wait until the other ${qty(diff)} arrives`, overPo ? "The PO must be increased first" : "The invoice stays open meanwhile"], effect: "hold" },
        ],
      });
    }
  }

  // Part bills: only part of a receipt is being billed.
  if (diff >= -EPS) {
    for (const candidate of selected) {
      const left = r3(candidate.view.open - candidate.view.allocated);
      if (left > EPS) {
        checks.push({
          id: `part-${i}-${candidate.view.key}`,
          lineIndex: i,
          sev: "ack",
          ask: "Is a part bill expected here?",
          title: `Billed ${qty(candidate.view.allocated)} of the ${qty(candidate.view.open)} received`,
          help: `${candidate.view.note ? `${candidate.view.note}. ` : ""}The other ${qty(left)} stays open on receipt ${candidate.view.docNum} for the vendor's next invoice.`,
          options: [
            { choice: "ok", title: "Yes, a part bill is expected", lines: [`Bill ${qty(candidate.view.allocated)} now`, `${qty(left)} waits for the next invoice`], effect: "resolve", recommended: true },
          ],
        });
      }
    }
  }

  // Rate
  const rate = effectiveRate(ln);
  if (rate !== null && poRate !== null && poRate > 0) {
    const pct = ((rate - poRate) / poRate) * 100;
    const absolutePct = Math.abs(pct);
    const difference = Math.abs(rate - poRate);
    const valueDifference = difference * result.allocatedQty;
    const direction = pct < 0 ? "below" : "above";
    if (Math.abs(pct) < 0.005) {
      checks.push({ id: `rate-${i}`, lineIndex: i, sev: "pass", title: "Rate matches the PO" });
    } else if (absolutePct <= rules.rateTolerancePct) {
      checks.push({
        id: `rate-${i}`,
        lineIndex: i,
        sev: "ack",
        ask: "Accept the different rate?",
        title: `Rate is ${inr(difference)} ${direction} the PO`,
        help: `${absolutePct.toFixed(2)}% ${direction}, inside your ${rules.rateTolerancePct}% limit. Invoice value differs by ${inr(valueDifference)} before tax.`,
        options: [{ choice: "ok", title: "Accept the vendor's rate", lines: [`Book ${inr(rate)}`, `Difference ${inr(valueDifference)} before tax`], effect: "resolve", recommended: true }],
      });
    } else {
      checks.push({
        id: `rate-${i}`,
        lineIndex: i,
        sev: "confirm",
        ask: "Use the invoice rate?",
        title: `Rate is ${inr(difference)} ${direction} the PO`,
        help: `${vendorName} charged ${inr(rate)}; the PO says ${inr(poRate)} (${absolutePct.toFixed(2)}% ${direction}), outside your ${rules.rateTolerancePct}% limit. Confirm with a reason, or return the invoice.`,
        options: [
          { choice: "confirm", title: "Use the invoice rate", lines: [`Book ${inr(rate)}`, `Difference ${inr(valueDifference)} before tax`, "The reason is saved in the audit trail"], effect: "resolve", needsReason: true },
          { ...RETURN_OPTION, recommended: true, lines: ["Ask for a corrected invoice at the PO rate"] },
        ],
      });
    }
  } else {
    checks.push({ id: `rate-${i}`, lineIndex: i, sev: "pass", title: "No PO rate to compare against" });
  }

  // Planned SAP lines: one per receipt used.
  let booked = 0;
  for (const candidate of selected) {
    const unitRate = effectiveRate(ln);
    const base = candidate.receipt.price;
    const freightPerUnit =
      rules.freightPolicy === "item" && invoice.freightAmount > 0 && totalQty > 0
        ? invoice.freightAmount / totalQty
        : 0;
    const wanted = unitRate !== null ? r4(unitRate + freightPerUnit) : null;
    const differs = wanted !== null && (base === null || Math.abs(wanted - base) > 0.005);
    planned.push({
      invoiceLineIndex: i,
      itemCode,
      quantity: candidate.view.allocated,
      unitPrice: differs ? wanted : null,
      lineTotal: null,
      baseType: 20,
      baseEntry: candidate.receipt.docEntry,
      baseLine: candidate.receipt.lineNum,
      baseDocNum: candidate.receipt.docNum,
      warehouse: candidate.receipt.warehouse,
    });
    booked += candidate.view.allocated;
  }
  return booked;
}

// ---------------------------------------------------------------------------
// Service (2-way) lines
// ---------------------------------------------------------------------------

function evaluateServiceLine(args: {
  ln: MatchInvoiceLine;
  itemCode: string;
  result: LineResult;
  invoice: MatchInvoice;
  context: MatchContext;
  state: MatchState;
  checks: Checks;
  planned: PlannedDocumentLine[];
}) {
  const { ln, itemCode, result, invoice, context, state, checks, planned } = args;
  const i = ln.index;
  const vendor = context.vendor!;
  const amount = ln.amount ?? 0;
  const invoicePos = invoice.poReferences.map(normalizeRef).filter(Boolean);

  const candidates = context.poLines
    .filter((po) => po.cardCode === vendor.cardCode && po.itemCode === itemCode)
    .map((po) => {
      const open = r2(po.openAmount ?? 0);
      const view = candidateView(receiptKey(po), "PO", po, open);
      if (context.branch?.bplId != null && po.branchId != null && po.branchId !== context.branch.bplId) {
        view.rejected = "Different branch";
        return { view, po };
      }
      if (open <= 0.5) {
        view.rejected = "Fully billed already";
        return { view, po };
      }
      let score = 30;
      view.good.push("same service");
      if (po.poRefs.some((ref) => invoicePos.includes(normalizeRef(ref)))) {
        score += 50;
        view.good.unshift("PO number is on the bill");
      } else {
        view.bad.push("PO number not on the bill");
      }
      if (open >= amount) {
        score += 20;
        view.good.push("enough value left");
      } else {
        view.bad.push(`only ${inr(open)} left`);
      }
      view.score = score;
      return { view, po };
    });

  const manual = state.allocations[String(i)];
  const eligible = candidates
    .filter((candidate) => !candidate.view.rejected)
    .sort((a, b) => b.view.score - a.view.score);
  let pick: (typeof candidates)[number] | undefined;
  if (manual) {
    result.manual = true;
    pick = eligible.find((candidate) => manual[candidate.view.key] != null);
  } else if (eligible[0] && eligible[0].view.score >= 50) {
    pick = eligible[0];
  }
  if (pick) pick.view.allocated = amount;
  result.candidates = candidates.map((candidate) => candidate.view);
  result.allocatedQty = pick ? amount : 0;

  checks.push({ id: `kind-${i}`, lineIndex: i, sev: "pass", title: "Service: nothing to receive, so no receipt is needed" });
  if (!pick) {
    checks.push({
      id: `rcpt-${i}`,
      lineIndex: i,
      sev: "block",
      title: "No open PO for this service",
      help: "A service bill needs an approved PO with value left. Ask purchasing to raise one.",
      options: [RETURN_OPTION],
    });
    return;
  }
  result.po = { docNum: pick.po.docNum, ref: pick.po.poRefs[0] ?? null, qty: pick.po.quantity, rate: pick.po.price };
  checks.push({ id: `rcpt-${i}`, lineIndex: i, sev: "pass", title: `Matched to PO ${pick.po.docNum}` });
  const open = pick.view.open;
  if (amount <= open + 0.5) {
    checks.push({ id: `amt-${i}`, lineIndex: i, sev: "pass", title: `Within the PO. ${inr(open - amount)} left for future bills` });
  } else {
    const over = amount - open;
    checks.push({
      id: `amt-${i}`,
      lineIndex: i,
      sev: "confirm",
      ask: "Pay more than the PO allows?",
      title: `Bill is ${inr(over)} more than the PO allows`,
      help: `The PO has ${inr(open)} left; the vendor billed ${inr(amount)} (${((over / open) * 100).toFixed(0)}% more). Confirm with a reason, or return the invoice.`,
      options: [
        { choice: "confirm", title: "Pay the full amount", lines: [`Pay ${inr(amount)} plus tax`, "The reason is saved in the audit trail"], effect: "resolve", needsReason: true },
        { ...RETURN_OPTION, recommended: true, lines: [`Ask them to bill ${inr(open)} now`, "Extra only after a PO increase"] },
      ],
    });
  }
  planned.push({
    invoiceLineIndex: i,
    itemCode,
    quantity: 1,
    unitPrice: null,
    lineTotal: amount,
    baseType: 22,
    baseEntry: pick.po.docEntry,
    baseLine: pick.po.lineNum,
    baseDocNum: pick.po.docNum,
    warehouse: null,
  });
}

/** Re-exported so callers can validate a decision before saving it. */
export function findOption(
  result: MatchResult,
  checkId: string,
  choice: string,
): { check: MatchCheck; option: CheckOption } | null {
  const check = result.checks.find((candidate) => candidate.id === checkId);
  if (!check) return null;
  const option = check.options?.find((candidate) => candidate.choice === choice);
  return option ? { check, option } : null;
}

export type { CheckEffect };
