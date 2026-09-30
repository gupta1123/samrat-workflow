import { dbCheck } from "@/server/api/helpers";
import { evaluateMatch, itemMappingKey, normalizeRef } from "@/lib/sap-match/engine";
import {
  EMPTY_MATCH_STATE,
  type MatchContext,
  type MatchInvoice,
  type MatchResult,
  type MatchRules,
  type MatchState,
  type SapItemInfo,
} from "@/lib/sap-match/types";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import { sapPostingDate } from "./dates";
import {
  branchForShipTo,
  buildMatchInvoice,
  mapPoLines,
  mapReceiptLines,
  resolveVendor,
  rulesFromRow,
  vendorKeys,
  type SapFieldConfig,
} from "./match-mapping";
import type { withTestServiceLayer } from "./service-layer";

type Db = ReturnType<typeof createSupabaseAdminClient>;
type Client = Parameters<Parameters<typeof withTestServiceLayer>[0]>[0];

export type CaseMatch =
  | { available: false; reason: string }
  | {
      available: true;
      invoice: MatchInvoice;
      rules: MatchRules;
      state: MatchState;
      vendor: MatchContext["vendor"];
      branch: MatchContext["branch"];
      result: MatchResult;
    };

export function sapFieldConfig(): SapFieldConfig {
  const field = (name: string, fallback: string) => {
    const value = (process.env[name] ?? fallback).trim();
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : undefined;
  };
  return {
    vehicleField: field("SAP_GRPO_VEHICLE_FIELD", "U_VEHNO"),
    invoiceRefField: field("SAP_GRPO_INVOICE_FIELD", "U_TATAINV"),
    eWayBillField: field("SAP_GRPO_EWAY_FIELD", "U_WAYBNO"),
    lorryReceiptField: field("SAP_GRPO_LR_FIELD", "U_LRNO"),
    poRefFields: (process.env.SAP_PO_REF_FIELDS ?? "")
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean),
  };
}

export async function loadMatchRules(db: Db): Promise<MatchRules> {
  const { data, error } = await db
    .from("sap_match_rules")
    .select("*")
    .eq("organization_id", "default")
    .maybeSingle();
  dbCheck(error);
  return rulesFromRow(data);
}

export async function saveMatchRules(db: Db, rules: MatchRules) {
  const { error } = await db.from("sap_match_rules").upsert(
    {
      organization_id: "default",
      qty_tolerance_pct: rules.qtyTolerancePct,
      rate_tolerance_pct: rules.rateTolerancePct,
      freight_policy: rules.freightPolicy,
      posting_date: rules.postingDate,
      receipt_window_days: rules.receiptWindowDays,
      branches: rules.branches,
    },
    { onConflict: "organization_id" },
  );
  dbCheck(error);
}

export async function loadMatchState(db: Db, caseId: string): Promise<MatchState> {
  const { data, error } = await db
    .from("sap_match_state")
    .select("decisions, allocations")
    .eq("case_id", caseId)
    .maybeSingle();
  dbCheck(error);
  if (!data) return { ...EMPTY_MATCH_STATE, decisions: {}, allocations: {} };
  return {
    decisions:
      data.decisions && typeof data.decisions === "object" && !Array.isArray(data.decisions)
        ? (data.decisions as MatchState["decisions"])
        : {},
    allocations:
      data.allocations && typeof data.allocations === "object" && !Array.isArray(data.allocations)
        ? (data.allocations as MatchState["allocations"])
        : {},
  };
}

export async function saveMatchState(
  db: Db,
  caseId: string,
  userId: string,
  state: MatchState,
) {
  const { error } = await db.from("sap_match_state").upsert(
    {
      case_id: caseId,
      owner_user_id: userId,
      decisions: state.decisions,
      allocations: state.allocations,
    },
    { onConflict: "case_id" },
  );
  dbCheck(error);
}

async function loadVendorMapping(db: Db, keys: string[]) {
  if (!keys.length) return null;
  const { data, error } = await db
    .from("sap_vendor_mappings")
    .select("vendor_key, sap_card_code, sap_card_name")
    .in("vendor_key", keys);
  dbCheck(error);
  const matched = data ?? [];
  if (!matched.length) return null;
  const cardCodes = new Set(matched.map((row) => String(row.sap_card_code)));
  if (cardCodes.size !== 1) return null;
  const row = matched[0];
  return {
    cardCode: String(row.sap_card_code),
    cardName: String(row.sap_card_name ?? row.sap_card_code),
  };
}

export async function saveVendorMapping(
  db: Db,
  input: { vendorKeys: string[]; cardCode: string; cardName: string | null; userId: string },
) {
  const { error } = await db.from("sap_vendor_mappings").upsert(
    input.vendorKeys.map((vendorKey) => ({
      vendor_key: vendorKey,
      sap_card_code: input.cardCode,
      sap_card_name: input.cardName,
      created_by: input.userId,
    })),
    { onConflict: "vendor_key" },
  );
  dbCheck(error);
}

async function loadItemMappings(db: Db, vendorCardCode: string) {
  const { data, error } = await db
    .from("sap_item_mappings")
    .select("vendor_item_key, sap_item_code")
    .in("vendor_card_code", [vendorCardCode, "*"]);
  dbCheck(error);
  const map: Record<string, string> = {};
  for (const row of data ?? []) map[String(row.vendor_item_key)] = String(row.sap_item_code);
  return map;
}

export async function saveItemMapping(
  db: Db,
  input: {
    vendorCardCode: string;
    vendorItemKey: string;
    sapItemCode: string;
    sapItemName: string | null;
    userId: string;
  },
) {
  const { error } = await db.from("sap_item_mappings").upsert(
    {
      vendor_card_code: input.vendorCardCode,
      vendor_item_key: input.vendorItemKey,
      sap_item_code: input.sapItemCode,
      sap_item_name: input.sapItemName,
      created_by: input.userId,
    },
    { onConflict: "vendor_card_code,vendor_item_key" },
  );
  dbCheck(error);
}

/**
 * Reads the packet and SAP, then evaluates the match. Nothing is written to
 * SAP or to the database here.
 */
export async function computeCaseMatch(params: {
  db: Db;
  client: Client;
  caseRow: { id: string; invoice_number: unknown; po_number: unknown };
}): Promise<CaseMatch> {
  const { db, client, caseRow } = params;
  const documents = await db
    .from("packet_documents")
    .select("document_type, extracted_fields")
    .eq("case_id", caseRow.id)
    .order("created_at");
  dbCheck(documents.error);
  const invoice = buildMatchInvoice({
    caseInvoiceNumber: caseRow.invoice_number,
    casePoNumber: caseRow.po_number,
    documents: documents.data ?? [],
  });
  if (!invoice) {
    return {
      available: false,
      reason: "This case has no numbered vendor invoice to match against SAP.",
    };
  }
  if (!invoice.lines.length) {
    return {
      available: false,
      reason: "No invoice line items were extracted, so there is nothing to match. Analyze the case again.",
    };
  }

  const [rules, state] = await Promise.all([
    loadMatchRules(db),
    loadMatchState(db, caseRow.id),
  ]);
  const config = sapFieldConfig();
  const branch = branchForShipTo(invoice.shipToGstin, rules);
  const keys = vendorKeys(invoice);
  let vendor: { cardCode: string; cardName: string } | null = null;
  let ambiguous: Array<{ cardCode: string; cardName: string; why: string }> = [];
  let suppliersRead: number | undefined;
  // A reviewer-confirmed choice is scoped to this case and never inferred.
  const selectedCardCode = state.decisions["vendor-link"]?.choice;
  if (selectedCardCode) {
    const supplier = await client.getSupplier(selectedCardCode);
    if (supplier) vendor = { cardCode: supplier.CardCode, cardName: supplier.CardName };
  }
  // A prior explicit link may be reused only for the same exact GSTIN and
  // vendor material code (or the same exact name when no GSTIN was available).
  const linked = vendor ? null : await loadVendorMapping(db, keys);
  if (linked) {
    const supplier = await client.getSupplier(linked.cardCode);
    if (supplier) vendor = { cardCode: supplier.CardCode, cardName: supplier.CardName };
  }
  if (!vendor) {
    const targeted = invoice.vendorName
      ? await client.searchSuppliers(invoice.vendorName)
      : [];
    if (targeted.length) {
      suppliersRead = targeted.length;
      ({ vendor, ambiguous } = resolveVendor(invoice, targeted));
    }
    if (!vendor && !ambiguous.length) {
      const suppliers = await client.listSuppliers();
      suppliersRead = suppliers.length;
      ({ vendor, ambiguous } = resolveVendor(invoice, suppliers));
    }
  }

  let receiptDocuments: Awaited<ReturnType<Client["listOpenReceiptDocumentsForVendor"]>> = [];
  let purchaseOrders: Awaited<ReturnType<Client["listOpenPurchaseOrdersForVendor"]>> = [];
  let itemMap: Record<string, string> = {};
  let existingInvoice: MatchContext["existingInvoice"] = null;
  if (vendor) {
    const [targetedReceipts, loadedItemMap] = await Promise.all([
      client.findOpenReceiptDocumentsForInvoice({
        cardCode: vendor.cardCode,
        invoiceNumber: invoice.invoiceNumber,
        eWayBill: invoice.eWayBill,
        lorryReceipt: invoice.lorryReceipt,
        vehicles: invoice.vehicles,
        invoiceRefField: config.invoiceRefField,
        eWayBillField: config.eWayBillField,
        lorryReceiptField: config.lorryReceiptField,
        vehicleField: config.vehicleField,
      }),
      loadItemMappings(db, vendor.cardCode),
    ]);
    itemMap = loadedItemMap;
    if (targetedReceipts.length) {
      receiptDocuments = targetedReceipts;
    } else {
      [receiptDocuments, purchaseOrders] = await Promise.all([
        client.listOpenReceiptDocumentsForVendor(vendor.cardCode),
        client.listOpenPurchaseOrdersForVendor(vendor.cardCode),
      ]);
    }
    // A receipt can stay open after its PO is closed, so fetch any PO a receipt points to.
    const known = new Set(purchaseOrders.map((po) => po.DocEntry));
    const referenced = receiptDocuments
      .flatMap((document) => document.DocumentLines ?? [])
      .flatMap((line) =>
        line.BaseType === 22 && typeof line.BaseEntry === "number" && !known.has(line.BaseEntry)
          ? [line.BaseEntry]
          : [],
      );
    if (referenced.length) {
      purchaseOrders = [...purchaseOrders, ...(await client.listPurchaseOrdersByEntries(referenced))];
    }
    const posted = await client.findInvoiceByReference(vendor.cardCode, invoice.invoiceNumber);
    if (posted) {
      existingInvoice = { docNum: posted.DocNum ?? posted.DocEntry ?? "?", kind: "invoice" };
    } else {
      const draft = await client.findDraftByVendorReference(vendor.cardCode, invoice.invoiceNumber);
      // A draft this app created for this very case is expected, not a duplicate.
      if (draft && !String(draft.Comments ?? "").startsWith(`Samrat case ${caseRow.id}`)) {
        existingInvoice = { docNum: draft.DocNum ?? draft.DocEntry ?? "?", kind: "draft" };
      }
    }
  }

  const receipts = mapReceiptLines(receiptDocuments, purchaseOrders, config);
  const poLines = mapPoLines(purchaseOrders, config);
  const itemCodes = [
    ...receipts.map((line) => line.itemCode),
    ...poLines.map((line) => line.itemCode),
    ...Object.values(itemMap),
  ];
  const itemRows = itemCodes.length ? await client.listItemsByCodes(itemCodes) : [];
  const items: Record<string, SapItemInfo> = {};
  for (const row of itemRows) {
    items[row.ItemCode] = {
      name: row.ItemName || row.ItemCode,
      inventory: row.InventoryItem === "tYES" ? true : row.InventoryItem === "tNO" ? false : null,
    };
  }

  const context: MatchContext = {
    vendor,
    ambiguousVendors: ambiguous,
    vendorKey: keys[0] ?? null,
    suppliersRead,
    branch,
    itemMap,
    items,
    receipts,
    poLines,
    existingInvoice,
    today: sapPostingDate(),
    closedBefore: null,
  };
  return {
    available: true,
    invoice,
    rules,
    state,
    vendor,
    branch,
    result: evaluateMatch({ invoice, context, rules, state }),
  };
}

export { itemMappingKey, normalizeRef };
