import {
  readStoredLineItems,
  stripStoredLineItems,
} from "../src/server/line-items";
import {
  assessRequiredDocumentCompliance,
  enrichProcessedDocuments,
  verifyProcessedDocuments,
} from "../src/server/processing/pipeline";
import { createSupabaseAdminClient } from "../src/server/supabase/admin";
import type { CaseDoc } from "../src/types/pipeline";

const caseId = process.argv[2];
if (!caseId) {
  throw new Error("Usage: npm run verify:persisted:local -- CASE_ID");
}

async function main() {
  const db = createSupabaseAdminClient();
  const result = await db
    .from("packet_documents")
    .select(
      "client_document_id,source_file_name,source_hint,document_type,title,page_count,extracted_fields,markdown",
    )
    .eq("case_id", caseId)
    .order("created_at");
  if (result.error) throw result.error;
  if (!result.data?.length) throw new Error("No persisted documents found.");

  const persistedDocuments = result.data.map((row): CaseDoc => ({
    id: row.client_document_id,
    type: row.document_type as CaseDoc["type"],
    title: row.title,
    pages: row.page_count,
    fields: stripStoredLineItems(row.extracted_fields ?? {}),
    lineItems: readStoredLineItems(row.extracted_fields),
    md: row.markdown,
    sourceFileName: row.source_file_name ?? undefined,
    sourceHint: row.source_hint ?? undefined,
  }));

  // The production job enriches once before review and again afterwards. Run the
  // same deterministic path twice so this check catches non-idempotent consensus.
  const documents = enrichProcessedDocuments(
    enrichProcessedDocuments(persistedDocuments),
  );
  const verified = verifyProcessedDocuments(documents);
  const requiredDocuments = assessRequiredDocumentCompliance(documents);

  console.log(
    JSON.stringify(
      {
        scope: "local-persisted-case-verification",
        caseId,
        documentCount: documents.length,
        mismatchCount: verified.mismatches.length,
        mismatches: verified.mismatches.map((mismatch) => ({
          field: mismatch.field,
          values: mismatch.values,
        })),
        requiredDocumentMismatchCount: requiredDocuments.mismatches.length,
      requiredDocumentChecks: requiredDocuments.checklist.map((item) => ({
        status: item.status,
        obligation: item.obligation,
        sourceClause: item.sourceClause,
      })),
      verificationGroups: verified.verificationGroups.map((group) => ({
        label: group.label,
        documentCount: group.documentIds.length,
        roleSelection: group.roleSelection,
      })),
      documents: documents.map((document) => ({
          id: document.id,
          type: document.type,
          invoiceNumber: document.fields.invoiceNumber,
          referenceInvoiceNumber: document.fields.referenceInvoiceNumber,
          lorryReceiptNumber: document.fields.lorryReceiptNumber,
          supplierGstin: document.fields.supplierGstin,
          buyerGstin: document.fields.buyerGstin,
          taxRate: document.fields.taxRate,
          cgstRate: document.fields.cgstRate,
          sgstRate: document.fields.sgstRate,
          igstRate: document.fields.igstRate,
        })),
      },
      null,
      2,
    ),
  );
}

void main();
