import { evaluateMatch } from "../src/lib/sap-match/engine";
import {
  DEFAULT_MATCH_RULES,
  EMPTY_MATCH_STATE,
  type MatchInvoice,
  type MatchContext,
} from "../src/lib/sap-match/types";
import { saveSapMatch } from "../src/lib/sap-posted-details";

const invoice: MatchInvoice = {
  invoiceNumber: "4130067129",
  invoiceDate: "2026-06-20",
  vendorName: "Tata Steel",
  vendorGstin: "20AAACT2803M2ZO",
  shipToGstin: "36AAQCS9189P1ZY",
  poReferences: ["274"],
  vehicles: ["TRUCK1"],
  eWayBill: null,
  lorryReceipt: null,
  taxCharged: "igst",
  taxRatePct: 18,
  currency: "INR",
  freightAmount: 0,
  taxableTotal: 200,
  taxTotal: 36,
  total: 236,
  lines: [
    {
      index: 0,
      vendorItemCode: "I01",
      description: "Steel bar",
      hsnSac: null,
      quantity: 2,
      unit: "MT",
      rate: 100,
      amount: 200,
    },
  ],
};
const context: MatchContext = {
  vendor: { cardCode: "TSPL001", cardName: "Tata Steel" },
  ambiguousVendors: [],
  branch: { bplId: 1, name: "Hyderabad", stateCode: "36", warehouse: "HYD" },
  itemMap: { I01: "TTR027" },
  items: { TTR027: { name: "Steel bar", inventory: true } },
  receipts: [
    {
      kind: "GRPO",
      docEntry: 168953,
      docNum: 718,
      lineNum: 0,
      date: "2026-06-20",
      cardCode: "TSPL001",
      itemCode: "TTR027",
      branchId: 1,
      warehouse: "HYD",
      poDocEntry: 274,
      poDocNum: 274,
      poLineNum: 0,
      poRefs: ["274"],
      quantity: 2,
      openQty: 2,
      price: 100,
      vehicle: "TRUCK1",
      vendorRef: invoice.invoiceNumber,
      eWayBill: null,
      lorryReceipt: null,
    },
  ],
  poLines: [
    {
      kind: "PO",
      docEntry: 274,
      docNum: 274,
      lineNum: 0,
      date: "2026-06-01",
      cardCode: "TSPL001",
      itemCode: "TTR027",
      branchId: 1,
      warehouse: "HYD",
      poRefs: ["274"],
      quantity: 10,
      openQty: 10,
      price: 100,
      lineTotal: 1000,
      openAmount: 1000,
    },
  ],
  existingInvoice: null,
  today: "2026-06-20",
  closedBefore: null,
};
const result = evaluateMatch({
  invoice,
  context,
  rules: DEFAULT_MATCH_RULES,
  state: EMPTY_MATCH_STATE,
});
if (result.status !== "ready")
  throw new Error(`Posted fixture must be ready: ${result.summary}`);
export const matchFixture = {
  invoice,
  result,
  vendor: context.vendor,
  branch: context.branch,
};
export const postedFixture = {
  kind: "AP",
  status: "posted",
  sap_env: "test",
  sap_docnum: "848",
  error: null,
  created_at: "2026-10-01",
  updated_at: "2026-10-01",
  payload: {
    invoiceNumber: invoice.invoiceNumber,
    baseKind: "GRPO",
    baseDocNum: "718",
    postingDate: "2026-06-20",
    invoiceDate: "2026-06-20",
    matchSnapshot: saveSapMatch(matchFixture, "2026-06-20"),
  },
  response: {
    CardCode: "TSPL001",
    DraftDocEntry: 237615,
    MaterialForm: "ST",
    PostingSummary: {
      vendorName: "Tata Steel",
      currency: "INR",
      total: 236,
      netPayable: 236,
      lines: [
        {
          ItemCode: "TTR027",
          ItemDescription: "Steel bar",
          Quantity: 2,
          UnitPrice: 100,
          LineTotal: 200,
        },
      ],
    },
  },
};
