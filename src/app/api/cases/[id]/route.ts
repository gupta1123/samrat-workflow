import {
  dbCheck,
  mapCase,
  ownedCase,
  uuid,
  withUser,
} from "@/server/api/helpers";
import { resolvePacketIntelligence } from "@/lib/packet-intelligence";
import { readComparisonOptions } from "@/server/comparison";
import { readStoredLineItems, stripStoredLineItems } from "@/server/line-items";
import { groupDocumentsForVerification } from "@/server/services/verification";
import type { CaseDoc } from "@/types/pipeline";
import { caseFileContentUrl } from "@/server/case-files";
import { getPersistedCaseIssueCount } from "@/lib/case-issues";
type Context = { params: Promise<{ id: string }> };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function splitShipmentIndex(
  processingMeta: unknown,
  caseId: string,
): Map<string, number> {
  const splitAnalysis = record(record(processingMeta).splitAnalysis);
  const groupCount = Number(splitAnalysis.groupCount);
  if (!Number.isFinite(groupCount) || groupCount < 2) return new Map();

  const indexes = new Map<string, number>();
  const currentIndex = Number(splitAnalysis.groupIndex);
  if (Number.isFinite(currentIndex) && currentIndex > 0) {
    indexes.set(caseId, currentIndex);
  }
  const siblings = splitAnalysis.siblingCases;
  if (Array.isArray(siblings)) {
    for (const sibling of siblings) {
      const entry = record(sibling);
      const id = String(entry.id ?? "").trim();
      const index = Number(entry.groupIndex);
      if (id && Number.isFinite(index) && index > 0) indexes.set(id, index);
    }
  }
  return indexes;
}

export async function GET(request: Request, context: Context) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    const row = await ownedCase(db, user, id);
    const [files, documents, mismatches] = await Promise.all([
      db
        .from("packet_case_files")
        .select("*")
        .eq("case_id", id)
        .order("created_at"),
      db
        .from("packet_documents")
        .select("*")
        .eq("case_id", id)
        .order("created_at"),
      db
        .from("packet_mismatches")
        .select("*")
        .eq("case_id", id)
        .order("created_at"),
    ]);
    [files.error, documents.error, mismatches.error].forEach(dbCheck);

    const documentResults = documents.data!.map((d) => ({
      id: d.id,
      clientDocumentId: d.client_document_id,
      sourceFileName: d.source_file_name,
      sourceHint: d.source_hint,
      documentType: d.document_type,
      title: d.title,
      pageCount: d.page_count,
      extractedFields: stripStoredLineItems(d.extracted_fields),
      lineItems: readStoredLineItems(d.extracted_fields),
      markdown: d.markdown,
      createdAt: d.created_at,
    }));
    const mismatchResults = mismatches.data!.map((m) => ({
      id: m.id,
      clientMismatchId: m.client_mismatch_id,
      fieldName: m.field_name,
      values: Array.isArray(m.values_json) ? m.values_json : [],
      analysis: m.analysis,
      fixPlan: m.fix_plan,
      resolutionStatus: m.resolution_status,
      resolvedAt: m.resolved_at,
      createdAt: m.created_at,
    }));

    const processingMeta = record(row.processing_meta);
    const comparisonOptions = readComparisonOptions(
      processingMeta.comparisonOptions,
    );
    const caseDocuments: CaseDoc[] = documentResults.map((document) => ({
      id: document.clientDocumentId || document.id,
      type: document.documentType as CaseDoc["type"],
      title: document.title,
      pages: Math.max(1, document.pageCount || 1),
      fields: document.extractedFields as CaseDoc["fields"],
      lineItems: document.lineItems,
      md: document.markdown,
      sourceFileName: document.sourceFileName || undefined,
      sourceHint: document.sourceHint || undefined,
    }));
    const verificationGroups = caseDocuments.length
      ? groupDocumentsForVerification(caseDocuments, comparisonOptions).map(
          ({ group }) => group,
        )
      : [];

    const duplicateCasesPromise = row.upload_fingerprint
      ? db
          .from("packet_cases")
          .select("id, display_name, status, created_at")
          .eq("owner_user_id", user)
          .eq("upload_fingerprint", row.upload_fingerprint)
          .neq("id", id)
          .is("deleted_at", null)
          .order("created_at")
      : Promise.resolve({ data: [], error: null });
    const shipmentIndexes = splitShipmentIndex(row.processing_meta, id);
    const shipmentCasesPromise =
      shipmentIndexes.size > 1
        ? db
            .from("packet_cases")
            .select(
              "id, display_name, buyer_name, invoice_number, status, document_count, mismatch_count, processing_meta",
            )
            .eq("owner_user_id", user)
            .in("id", Array.from(shipmentIndexes.keys()))
            .is("deleted_at", null)
        : Promise.resolve({ data: [], error: null });
    const [duplicateCasesResult, shipmentCasesResult] = await Promise.all([
      duplicateCasesPromise,
      shipmentCasesPromise,
    ]);
    dbCheck(duplicateCasesResult.error);
    dbCheck(shipmentCasesResult.error);

    const duplicateCases = (duplicateCasesResult.data ?? []).map((entry) => ({
      id: entry.id,
      displayName: entry.display_name,
      status: entry.status,
      createdAt: entry.created_at,
    }));
    const shipmentCases = (shipmentCasesResult.data ?? [])
      .map((entry) => ({
        id: entry.id,
        displayName: entry.display_name,
        buyerName: entry.buyer_name,
        invoiceNumber: entry.invoice_number,
        status: entry.status,
        documentCount: entry.document_count,
        mismatchCount: entry.mismatch_count,
        shipmentIndex: shipmentIndexes.get(entry.id) ?? Number.MAX_SAFE_INTEGER,
        isCurrent: entry.id === id,
      }))
      .sort((left, right) => left.shipmentIndex - right.shipmentIndex);

    const fileResults = files.data!.map((f) => ({
      id: f.id,
      originalName: f.original_name,
      storageBucket: f.storage_bucket,
      storagePath: f.storage_path,
      mimeType: f.mime_type,
      sizeBytes: f.size_bytes,
      createdAt: f.created_at,
      signedUrl: caseFileContentUrl(id, f.id),
    }));
    const caseResult = {
      ...mapCase(row),
      mismatchCount: getPersistedCaseIssueCount(mismatchResults),
    };
    return {
      case: caseResult,
      files: fileResults,
      documents: documentResults,
      mismatches: mismatchResults,
      packetIntelligence: caseDocuments.length
        ? resolvePacketIntelligence({
            documents: documentResults,
            mismatches: mismatchResults,
            processingMeta: {
              ...processingMeta,
              ...(row.upload_fingerprint
                ? { uploadFingerprint: row.upload_fingerprint }
                : {}),
            },
            duplicateCases,
            verificationGroups,
          })
        : null,
      shipmentCases,
    };
  });
}
async function mutate(request: Request, context: Context, action: string) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    const { data, error } = await db.rpc("decide_case", {
      p_user: user,
      p_case: uuid(id),
      p_action: action,
    });
    dbCheck(error);
    return { case: mapCase(data) };
  });
}
export async function PATCH(request: Request, context: Context) {
  const body = await request
    .clone()
    .json()
    .catch(() => ({}));
  const action = body.action;
  return mutate(
    request,
    context,
    ["accept", "reject", "restore"].includes(action) ? action : "invalid",
  );
}
export async function DELETE(request: Request, context: Context) {
  return mutate(
    request,
    context,
    new URL(request.url).searchParams.get("mode") === "hard"
      ? "delete"
      : "recycle",
  );
}
