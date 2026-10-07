import { buildEWayBillValidityIssues } from "@/lib/eway-bill-validity";
import { getAnalysisIntegrityApprovalBlockReason } from "@/lib/analysis-integrity";
import type { CaseDoc } from "@/types/pipeline";
import type { createSupabaseAdminClient } from "./supabase/admin";
import { dbCheck } from "./api/helpers";
import { stripStoredLineItems } from "./line-items";

// Recheck unapproved cases against the current day without repeating AI analysis.
// Accepted historical cases are not silently unapproved by a page read.
export async function refreshEWayBillValidityIssues(
  db: ReturnType<typeof createSupabaseAdminClient>,
  row: { id: string; status: string; processing_meta: unknown },
  now = new Date(),
) {
  if (
    row.status !== "completed" ||
    getAnalysisIntegrityApprovalBlockReason(row.processing_meta)
  )
    return;
  const documents = await db
    .from("packet_documents")
    .select(
      "client_document_id, document_type, title, page_count, extracted_fields, source_file_name, markdown",
    )
    .eq("case_id", row.id)
    .eq("document_type", "E-Way Bill");
  dbCheck(documents.error);
  const docs: CaseDoc[] = (documents.data ?? []).map((doc) => ({
    id: doc.client_document_id,
    type: "E-Way Bill",
    title: doc.title,
    pages: doc.page_count,
    fields: stripStoredLineItems(doc.extracted_fields),
    sourceFileName: doc.source_file_name ?? undefined,
    md: doc.markdown ?? "",
  }));
  const issues = buildEWayBillValidityIssues(docs, now);
  if (!issues.length) return;
  const result = await db
    .from("packet_mismatches")
    .upsert(
      issues.map((issue) => ({
        case_id: row.id,
        client_mismatch_id: issue.id,
        field_name: issue.field,
        values_json: issue.values,
        analysis: issue.analysis,
        fix_plan: issue.fixPlan,
        resolution_status: "pending",
      })),
      { onConflict: "case_id,client_mismatch_id", ignoreDuplicates: true },
    )
    .select("id");
  // Conflict-ignore preserves accepted/rejected decisions and their audit trail.
  dbCheck(result.error);
  if (result.data?.length) {
    const count = await db
      .from("packet_mismatches")
      .select("id", { count: "exact", head: true })
      .eq("case_id", row.id);
    dbCheck(count.error);
    const updated = await db
      .from("packet_cases")
      .update({ mismatch_count: count.count ?? 0 })
      .eq("id", row.id)
      .eq("status", "completed");
    dbCheck(updated.error);
  }
}
