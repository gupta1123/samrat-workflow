import { MISSING_DOCUMENTS_FIELD } from "@/lib/missing-documents";
import {
  LOGISTICS_REQUIREMENT_KEYS,
  storedSupplyNature,
} from "@/lib/supply-nature";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";

type Db = ReturnType<typeof createSupabaseAdminClient>;

const LOGISTICS_GROUPS = new Set(["Transport Document", "Weight Proof"]);
const COMMERCIAL_TYPES = new Set([
  "Invoice",
  "Tax Invoice",
  "Purchase Order",
  "Amended Purchase Order",
]);

/**
 * A case reviewed against PO lines (non-stock or service) has nothing to
 * transport or weigh, so a "missing Transport Document / Weight Proof" issue is
 * settled for it. Skipped when the invoice or PO says in so many words that the
 * document is required. Returns the number of issues settled.
 */
export async function settleLogisticsForPoLineCase(
  db: Db,
  caseId: string,
  reviewFlow: string | null,
) {
  if (reviewFlow !== "non_stock_po" && reviewFlow !== "service_po") return 0;
  const { data: row } = await db
    .from("packet_cases")
    .select("owner_user_id,processing_meta")
    .eq("id", caseId)
    .is("deleted_at", null)
    .maybeSingle();
  const groups = (row?.processing_meta as { missingDocumentGroups?: unknown })
    ?.missingDocumentGroups;
  if (
    !row ||
    !Array.isArray(groups) ||
    !groups.length ||
    !groups.every((group) => LOGISTICS_GROUPS.has(String(group).trim()))
  )
    return 0;

  const { data: documents } = await db
    .from("packet_documents")
    .select("type,extracted_fields")
    .eq("case_id", caseId);
  const requiredInSource = (documents ?? []).some(
    (doc) =>
      COMMERCIAL_TYPES.has(doc.type) &&
      LOGISTICS_REQUIREMENT_KEYS.some(
        (key) =>
          storedSupplyNature(doc.extracted_fields)?.logisticsRequirements?.[key]
            ?.status === "required",
      ),
  );
  if (requiredInSource) return 0;

  const { data: pending } = await db
    .from("packet_mismatches")
    .select("id")
    .eq("case_id", caseId)
    .eq("field_name", MISSING_DOCUMENTS_FIELD)
    .eq("resolution_status", "pending");
  const ids = (pending ?? []).map((issue) => issue.id);
  if (!ids.length) return 0;
  const { error } = await db.rpc("resolve_mismatches", {
    p_user: row.owner_user_id,
    p_case: caseId,
    p_ids: ids,
    p_decision: "accepted",
  });
  if (error) {
    console.warn("Logistics issue not settled", {
      caseId,
      error: error.message,
    });
    return 0;
  }
  return ids.length;
}
