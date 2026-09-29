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
  return {
    vehicleField: (process.env.SAP_GRPO_VEHICLE_FIELD ?? "").trim() || undefined,
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
  const suppliers = await client.listSuppliers();
  const { vendor, ambiguous } = resolveVendor(invoice.vendorName, suppliers);

  let receiptDocuments: Awaited<ReturnType<Client["listOpenReceiptDocumentsForVendor"]>> = [];
  let purchaseOrders: Awaited<ReturnType<Client["listOpenPurchaseOrdersForVendor"]>> = [];
  let itemMap: Record<string, string> = {};
  let existingInvoice: MatchContext["existingInvoice"] = null;
  if (vendor) {
    [receiptDocuments, purchaseOrders, itemMap] = await Promise.all([
      client.listOpenReceiptDocumentsForVendor(vendor.cardCode),
      client.listOpenPurchaseOrdersForVendor(vendor.cardCode),
      loadItemMappings(db, vendor.cardCode),
    ]);
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
