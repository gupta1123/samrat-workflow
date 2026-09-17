import {
  buildAuthoritativeTermsComplianceResult,
  processStoredCaseFiles,
} from "../src/server/processing/pipeline";
import { reviewExtractedDocumentsInStages } from "../src/server/processing/staged-review";
import {
  buildInvoiceNumberRequiredIssues,
  consolidateInvoiceNumberIssues,
} from "../src/lib/invoice-approval";
import { createSupabaseAdminClient } from "../src/server/supabase/admin";

const caseId = process.argv[2];
const analysisMode =
  process.argv[3] === "standard" ? "standard" : "smart_split";

if (!caseId) {
  throw new Error(
    "Usage: npm run benchmark:local -- CASE_ID [smart_split|standard]",
  );
}

const phases: Record<string, number> = {};
async function measure<T>(name: string, work: () => Promise<T>) {
  const startedAt = Date.now();
  try {
    return await work();
  } finally {
    phases[name] = Date.now() - startedAt;
  }
}

async function main() {
  const sourceCase = await createSupabaseAdminClient()
    .from("packet_cases")
    .select("id,deleted_at")
    .eq("id", caseId)
    .maybeSingle();
  if (sourceCase.error) throw sourceCase.error;
  if (!sourceCase.data || sourceCase.data.deleted_at)
    throw new Error(
      "Benchmark requires an active case. Recycled case documents are not sent to AI providers.",
    );
  const startedAt = Date.now();
  const processed = await measure("extractAndCompareMs", () =>
    processStoredCaseFiles({ caseId, analysisMode }),
  );
  const reviewed = await measure("extractionReviewMs", () =>
    reviewExtractedDocumentsInStages(processed.documents, {
      sourcePages: processed.reviewPages,
      comparisonOptions: processed.comparisonOptions,
      onReviewStage: async (progress, stage) => {
        console.log(JSON.stringify({ progress, stage }));
      },
    }),
  );
  const reviewedDocuments = reviewed.documents;
  const terms = buildAuthoritativeTermsComplianceResult(
    reviewedDocuments,
    reviewed.authoritativeReview.termsChecklist,
  );
  const mismatches = consolidateInvoiceNumberIssues(
    [
      ...reviewed.authoritativeReview.mismatches,
      ...reviewed.reviewIssues,
      ...terms.mismatches,
    ],
    buildInvoiceNumberRequiredIssues({
      invoiceNumber:
        reviewed.authoritativeReview.verificationGroups[0]?.caseSummary
          .invoiceNumber,
      documents: reviewedDocuments.map((document) => ({
        id: document.id,
        documentType: document.type,
        invoiceNumber: document.fields.invoiceNumber,
      })),
      verificationGroups: reviewed.authoritativeReview.verificationGroups,
    }),
  );

  console.log(
    JSON.stringify({
      scope: "read-only-case-benchmark",
      caseId,
      analysisMode,
      totalMs: Date.now() - startedAt,
      phases,
      documentCount: reviewedDocuments.length,
      preliminaryMismatchCount: reviewed.review.candidateMismatchCount,
      finalMismatchCount: mismatches.length,
      finalMismatchFields: mismatches.map((mismatch) => mismatch.field),
      extractionReview: reviewed.review,
      documentPageQuality: reviewed.pageQuality,
      verificationGroups: reviewed.authoritativeReview.verificationGroups,
      reviewIssueCount: reviewed.reviewIssues.length,
      reviewIssueFields: reviewed.reviewIssues.map(
        (mismatch) => mismatch.field,
      ),
      reviewCorrectionCount: reviewed.review.correctionCount,
      termsChecklistCount: terms.checklist.length,
      termsMismatchCount: terms.mismatches.length,
      termsStatuses: terms.checklist.map((item) => ({
        category: item.category,
        status: item.status,
        obligation: item.obligation,
      })),
      documentChecks: reviewedDocuments.map((document) => ({
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
      persisted: false,
    }),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
