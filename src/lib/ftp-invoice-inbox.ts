export type FtpInvoiceStatus =
  | "copying"
  | "ready"
  | "queued"
  | "importing"
  | "analyzing"
  | "failed"
  | "archive_pending"
  | "archived"
  | "missing";

export type FtpInvoice = {
  id: string;
  fileName: string;
  discoveredAt: string;
  status: FtpInvoiceStatus;
  caseId: string | null;
  error: string | null;
  canAnalyze: boolean;
};

export type FtpInvoicePage = {
  rows: FtpInvoice[];
  page: number;
  totalPages: number;
  lastSuccessAt: string | null;
  connectionError: string | null;
};
