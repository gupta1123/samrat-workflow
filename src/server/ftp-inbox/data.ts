import type { FtpInvoiceStatus } from "@/lib/ftp-invoice-inbox";
import { ApiError } from "@/server/api/helpers";

export const SCAN_INTERVAL_MS = 120_000;
export const INBOX_PAGE_SIZE = 25;

export type FtpInvoiceRow = {
  id: string;
  file_name: string;
  size_bytes: number;
  modified_at: string | null;
  discovered_at: string;
  present: boolean;
  status: FtpInvoiceStatus;
  requested_at: string | null;
  owner_user_id: string | null;
  case_id: string | null;
  analysis_job_id: string | null;
  sha256: string | null;
  archive_name: string | null;
  next_archive_at: string | null;
  error: string | null;
};

export function checkInboxError(error: { code?: string } | null) {
  if (error?.code === "PGRST205" || error?.code === "42P01")
    throw new ApiError("The invoice inbox database setup is pending.", 503);
  if (error) throw error;
}

export function canAnalyzeInvoice(row: FtpInvoiceRow, userId: string) {
  return (
    (row.status === "ready" || row.status === "failed") &&
    (!row.owner_user_id || row.owner_user_id === userId) &&
    (row.present || Boolean(row.case_id))
  );
}
