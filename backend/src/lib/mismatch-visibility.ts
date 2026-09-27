import { DOCUMENT_READABILITY_FIELD } from "@/lib/document-readability";
import { DUPLICATE_INVOICE_FIELD } from "@/lib/duplicate-invoice";
import { EXTRACTION_VERIFICATION_FIELD } from "@/lib/extraction-verification";
import { INVOICE_NUMBER_REQUIRED_FIELD } from "@/lib/invoice-approval";
import { MISSING_DOCUMENTS_FIELD } from "@/lib/missing-documents";
import { WEIGHT_CALCULATION_FIELD } from "@/lib/weight-calculation";

export function isAlwaysVisibleReviewIssue(fieldName: string) {
  return (
    fieldName === DOCUMENT_READABILITY_FIELD ||
    fieldName === DUPLICATE_INVOICE_FIELD ||
    fieldName === EXTRACTION_VERIFICATION_FIELD ||
    fieldName === INVOICE_NUMBER_REQUIRED_FIELD ||
    fieldName === MISSING_DOCUMENTS_FIELD ||
    fieldName === WEIGHT_CALCULATION_FIELD
  );
}
