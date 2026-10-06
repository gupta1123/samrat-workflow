// Types for the SAP invoice matching engine. Everything here is plain data so
// the same engine runs on the server (against real SAP rows) and in tests.

export type FreightPolicy = "expense" | "item" | "separate";

export type MatchRules = {
  /** How much more than received a vendor may bill before the invoice is blocked (percent of received). */
  qtyTolerancePct: number;
  /** How much the invoice rate may differ from the PO with a simple confirmation (percent). */
  rateTolerancePct: number;
  freightPolicy: FreightPolicy;
  /** Which date SAP books the invoice on. The GST (tax) date is always the vendor's invoice date. */
  postingDate: "invoice" | "today";
  /** Receipts recorded within this many days after the invoice date rank higher. */
  receiptWindowDays: number;
  /** Maps a ship-to GSTIN state code (e.g. "37") to a SAP branch. Optional. */
  branches: BranchMapping[];
};

export type BranchMapping = {
  stateCode: string;
  name: string;
  bplId: number | null;
  warehouse: string | null;
};

export const DEFAULT_MATCH_RULES: MatchRules = {
  qtyTolerancePct: 1,
  rateTolerancePct: 0.5,
  freightPolicy: "expense",
  postingDate: "invoice",
  receiptWindowDays: 30,
  branches: [],
};

// ---- Invoice (from the extracted packet) ----

export type MatchInvoiceLine = {
  index: number;
  /** The vendor's own material code (e.g. Tata's 3434405). */
  vendorItemCode: string | null;
  description: string | null;
  hsnSac: string | null;
  quantity: number | null;
  unit: string | null;
  rate: number | null;
  /** Taxable value of the line. */
  amount: number | null;
};

export type MatchInvoice = {
  invoiceNumber: string;
  /** The primary scanned invoice, when recorded in the saved packet. */
  source?: { fileName: string | null; pageLabel: string | null };
  referenceSources?: {
    po: Array<{ value: string; source: string }>;
    eWayBill: string | null;
    lorryReceipt: string | null;
    vehicles: Array<{ value: string; source: string }>;
  };
  /** YYYY-MM-DD */
  invoiceDate: string | null;
  vendorName: string | null;
  vendorGstin: string | null;
  shipToGstin: string | null;
  /** PO references printed on the invoice, in any format. */
  poReferences: string[];
  vehicles: string[];
  eWayBill: string | null;
  lorryReceipt: string | null;
  /** The GST type actually charged on the invoice. */
  taxCharged: "igst" | "split" | "unknown";
  taxRatePct: number | null;
  currency: string | null;
  freightAmount: number;
  taxableTotal: number | null;
  taxTotal: number | null;
  total: number | null;
  lines: MatchInvoiceLine[];
};

// ---- SAP data ----

export type SapReceiptLine = {
  kind: "GRPO";
  docEntry: number;
  docNum: number;
  lineNum: number;
  date: string | null;
  cardCode: string;
  itemCode: string;
  branchId: number | null;
  warehouse: string | null;
  /** The purchase order line this receipt was created from. */
  poDocEntry: number | null;
  poDocNum: number | null;
  poLineNum: number | null;
  /** Every reference that may identify this receipt's PO on a vendor invoice (DocNum, NumAtCard, UDFs). */
  poRefs: string[];
  quantity: number;
  openQty: number;
  price: number | null;
  vehicle: string | null;
  /** The vendor invoice number stores may have written on the receipt. */
  vendorRef: string | null;
  /** Strong logistics identifiers copied from the receipt header. */
  eWayBill: string | null;
  lorryReceipt: string | null;
  /** Free text such as "Two trucks were unloaded on one receipt". */
  note?: string | null;
  /** Set when the receipt is already fully billed, to explain the rejection. */
  invoicedBy?: string | null;
};

export type SapPoLine = {
  kind: "PO";
  docEntry: number;
  docNum: number;
  lineNum: number;
  date: string | null;
  cardCode: string;
  itemCode: string;
  branchId: number | null;
  warehouse: string | null;
  poRefs: string[];
  quantity: number;
  openQty: number;
  price: number | null;
  /** Ordered / open value, used for service lines. */
  lineTotal: number | null;
  openAmount: number | null;
  description?: string | null;
};

export type SapItemInfo = {
  name: string;
  /** true = stock item (3-way match), false = service/non-stock (2-way match), null = unknown. */
  inventory: boolean | null;
};

export type SupplierIdentification = {
  method: "gstin" | "name" | "saved-mapping" | "reviewer";
  sapGstins: string[];
  mappingKey?: string;
};

export type ReceiptSearch = {
  method: "identifier" | "vendor";
  field?: string;
  value?: string;
  /** Every exact packet identifier that returned at least one open GRPO. */
  identifiers?: Array<{ field: string; value: string }>;
  /** Exact hits were supplemented with every open GRPO for the same SAP supplier. */
  supplementedByVendor?: boolean;
  documentsRead: number;
  limit: number;
};

export type MatchContext = {
  vendor: { cardCode: string; cardName: string } | null;
  supplierIdentification?: SupplierIdentification | null;
  receiptSearch?: ReceiptSearch;
  checkedAt?: string;
  itemMappingScopes?: Record<string, "supplier" | "shared">;
  /** More than one SAP vendor has the same authoritative invoice identifier. */
  ambiguousVendors: Array<{ cardCode: string; cardName: string; why: string }>;
  /** How this invoice's vendor is remembered (GSTIN or name), used when linking it to a SAP vendor. */
  vendorKey?: string | null;
  /** How many SAP suppliers were read; 0 usually means a permission problem. */
  suppliersRead?: number;
  branch: {
    bplId: number | null;
    name: string;
    stateCode: string | null;
    warehouse: string | null;
  } | null;
  /** vendor material code (normalised) → SAP item code */
  itemMap: Record<string, string>;
  items: Record<string, SapItemInfo>;
  receipts: SapReceiptLine[];
  poLines: SapPoLine[];
  /** A non-cancelled SAP A/P invoice already carries this vendor invoice number. */
  existingInvoice: {
    docNum: string | number;
    kind?: "invoice" | "draft";
  } | null;
  /** YYYY-MM-DD used as "today" (injected so tests are deterministic). */
  today: string;
  /** Posting dates before this are in a closed SAP period. null = unknown / not checked. */
  closedBefore: string | null;
};

// ---- Reviewer state (saved per case) ----

export type MatchDecision = { choice: string; reason?: string; at: string };

export type MatchState = {
  decisions: Record<string, MatchDecision>;
  /** invoice line index → receipt/PO line key → quantity (or amount for services) chosen by the reviewer */
  allocations: Record<string, Record<string, number>>;
};

export const EMPTY_MATCH_STATE: MatchState = { decisions: {}, allocations: {} };

// ---- Result ----

export type MatchStatus =
  "ready" | "review" | "blocked" | "waiting" | "returned" | "closed";

export type CheckSeverity =
  "pass" | "unchecked" | "ack" | "confirm" | "wait" | "block";

export type CheckEffect =
  "resolve" | "return" | "hold" | "stores" | "close" | "use-today";

export type CheckOption = {
  choice: string;
  title: string;
  lines: string[];
  effect: CheckEffect;
  needsReason?: boolean;
  recommended?: boolean;
};

export type MatchCheck = {
  id: string;
  lineIndex: number | null;
  sev: CheckSeverity;
  title: string;
  help?: string;
  ask?: string;
  options?: CheckOption[];
  /** Text shown while the check is waiting on someone else. */
  waitNote?: string;
  /** Set when the admin already answered this check. */
  decision?: MatchDecision & { effect: CheckEffect };
  /** True while the check still stops the invoice from going to SAP. */
  open: boolean;
  /** Suggested SAP items, shown when an item is not yet linked. */
  itemSuggestions?: Array<{ itemCode: string; name: string; why: string }>;
  /** Set on the vendor check when the vendor could not be matched. */
  vendorSuggestions?: Array<{
    cardCode: string;
    cardName: string;
    why: string;
  }>;
  vendorKey?: string | null;
};

export type CandidateView = {
  key: string;
  kind: "GRPO" | "PO";
  docNum: number;
  docEntry: number;
  lineNum: number;
  date: string | null;
  poRef: string | null;
  vehicle: string | null;
  quantity: number;
  open: number;
  price: number | null;
  score: number;
  good: string[];
  bad: string[];
  rejected: string | null;
  allocated: number;
  note: string | null;
  references?: {
    po: string[];
    invoice: string | null;
    eWayBill: string | null;
    lorryReceipt: string | null;
  };
  itemCode?: string;
  supplierCode?: string;
  purchaseOrder?: {
    docEntry: number;
    docNum: number | null;
    lineNum: number | null;
  } | null;
};

export type LineResult = {
  index: number;
  kind: "material" | "service" | "unmapped";
  itemCode: string | null;
  itemName: string | null;
  invoiceQty: number | null;
  invoiceRate: number | null;
  invoiceAmount: number | null;
  candidates: CandidateView[];
  allocatedQty: number;
  manual: boolean;
  itemIdentification?: {
    method: "saved-mapping" | "exact-code";
    scope?: "supplier" | "shared";
  };
  /** Ordered quantity/rate/value of the PO the allocation points at. */
  po: {
    docNum: number | null;
    ref: string | null;
    qty: number | null;
    rate: number | null;
    /** A GRPO rate can be used when the linked PO price is unavailable. */
    rateSource?: "po" | "grpo";
  } | null;
};

export type PlannedDocumentLine = {
  invoiceLineIndex: number;
  itemCode: string;
  quantity: number;
  /** Only set when the rate to book differs from the base document's rate. */
  unitPrice: number | null;
  /** For service lines that bill an amount instead of a quantity. */
  lineTotal: number | null;
  baseType: 20 | 22;
  baseEntry: number;
  baseLine: number;
  baseDocNum: number;
  warehouse: string | null;
};

export type PlannedPayload = {
  cardCode: string;
  numAtCard: string;
  /** YYYY-MM-DD */
  docDate: string;
  taxDate: string;
  branchId: number | null;
  comments: string;
  lines: PlannedDocumentLine[];
  /** Freight booked as an additional expense (policy "expense"), else null. */
  freightExpense: number | null;
  /** Freight left out because it is paid separately. */
  freightExcluded: number;
  bookedTaxable: number;
  invoiceTaxable: number | null;
  /** Unbooked value (rounding or freight paid separately) so the reviewer can see it. */
  difference: number | null;
};

export type MatchResult = {
  checkedAt?: string;
  supplierIdentification?: SupplierIdentification | null;
  receiptSearch?: ReceiptSearch;
  status: MatchStatus;
  checks: MatchCheck[];
  open: MatchCheck[];
  lines: LineResult[];
  payload: PlannedPayload | null;
  /** Ordered list of the SAP documents the draft will be based on. */
  baseDocuments: Array<{
    kind: "GRPO" | "PO";
    docNum: number;
    docEntry: number;
  }>;
  method: "3-way" | "2-way" | "mixed" | "unknown";
  summary: string;
  postingDate: string | null;
};
