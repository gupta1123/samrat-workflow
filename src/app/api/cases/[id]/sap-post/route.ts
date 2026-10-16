import { finalInvoicePostingDisabled } from "@/server/sap/draft-only-policy";

// Retired direct-posting endpoint. Use the verified draft-creation workflow.
export async function POST() {
  return finalInvoicePostingDisabled();
}
