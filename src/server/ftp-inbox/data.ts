import type { FtpInvoiceStatus } from "@/lib/ftp-invoice-inbox";
import { ApiError } from "@/server/api/helpers";
import type { AutomaticIntake } from "@/server/automatic-intake";
import { UPLOAD_LIMITS } from "@/server/uploads";

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

export function isAutomaticFtpInvoice(
  row: FtpInvoiceRow,
  config: AutomaticIntake | null,
  now: Date,
) {
  return Boolean(
    config &&
    row.present &&
    row.size_bytes > 0 &&
    row.size_bytes <= UPLOAD_LIMITS.bytes &&
    Date.parse(row.discovered_at) >= Date.parse(config.fromInstant) &&
    Date.parse(row.discovered_at) <= now.getTime() &&
    (!row.owner_user_id || row.owner_user_id === config.owner),
  );
}
