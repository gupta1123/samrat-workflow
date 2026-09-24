"use client";

import { apiFetch } from "@/lib/api-client";
import type { SapClassification } from "@/lib/sap-decision";

export type SapPostingRecord = {
  kind: string;
  status: string;
  sap_env: string;
  sap_docnum: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type SapCandidate = {
  docNum: string;
  vendorName: string | null;
  totalAmount: number | null;
  score: number;
  reasons: string[];
};

export type SapReadiness = {
  sapEnv: string;
  caseStatus: string;
  postable: boolean;
  classification: SapClassification;
  openPoCount: number;
  openGrpoCount: number;
  matchedPoDocNum: string | null;
  matchedGrpoDocNum: string | null;
  candidatePOs: SapCandidate[];
  candidateGRPOs: SapCandidate[];
  caseVendor: string | null;
  caseTotal: number | null;
  sapError: string | null;
  postings: SapPostingRecord[];
};

export async function fetchSapReadiness(caseId: string): Promise<SapReadiness> {
  const response = await apiFetch(
    `/api/cases/${encodeURIComponent(caseId)}/sap-readiness`,
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof body.error === "string" && body.error
        ? body.error
        : "Could not load SAP readiness.",
    );
  }
  return body as SapReadiness;
}

export async function createSapApDraft(
  caseId: string,
  base: { baseGrpoDocNum?: string | null; basePoDocNum?: string | null },
) {
  const response = await apiFetch(
    `/api/cases/${encodeURIComponent(caseId)}/sap-ap-draft`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(base),
    },
  );
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}
