import { finalInvoicePostingDisabled } from "@/server/sap/draft-only-policy";

// Kept as an explicit tombstone so stale tabs cannot post existing drafts.
export async function GET() {
  return finalInvoicePostingDisabled();
}

export async function POST() {
  return finalInvoicePostingDisabled();
}
