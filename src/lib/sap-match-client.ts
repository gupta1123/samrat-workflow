"use client";

import { apiFetch } from "@/lib/api-client";
import type { PostedSapDetails } from "./sap-posted-details";
import type { DraftFieldChoices, DraftHeaderPreview } from "./sap-draft-fields";
import type {
  MatchInvoice,
  MatchResult,
  MatchRules,
  MatchState,
} from "@/lib/sap-match/types";

export type SapMatchPosting = {
  kind: string;
  status: string;
  sap_env: string;
  sap_docnum: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type Shared = {
  sapEnv: string;
  caseStatus: string;
  postable: boolean;
  postings: SapMatchPosting[];
  postedDetails?: PostedSapDetails;
  draftDetails?: PostedSapDetails;
  matchJob?: {
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    stage: string;
    error: string | null;
    attempt: number;
    requestedAt: string;
    finishedAt: string | null;
  };
};

export type SapMatchUnavailable = Shared & {
  available: false;
  reason?: string;
  sapError?: string;
};

export type SapMatchAvailable = Shared & {
  available: true;
  invoice: MatchInvoice;
  rules: MatchRules;
  state: MatchState;
  vendor: { cardCode: string; cardName: string } | null;
  branch: {
    bplId: number | null;
    name: string;
    stateCode: string | null;
    warehouse: string | null;
  } | null;
  result: MatchResult;
};

export type SapMatchResponse = SapMatchUnavailable | SapMatchAvailable;

async function readJson(response: Response) {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function errorText(body: Record<string, unknown>, fallback: string) {
  return typeof body.error === "string" && body.error ? body.error : fallback;
}

export async function fetchSapMatch(
  caseId: string,
  refresh = false,
): Promise<SapMatchResponse> {
  const response = await apiFetch(
    `/api/cases/${encodeURIComponent(caseId)}/sap-match${refresh ? "?refresh=1" : ""}`,
    {
      cache: "no-store",
    },
  );
  const body = await readJson(response);
  if (!response.ok)
    throw new Error(errorText(body, "Could not load the SAP match."));
  return body as unknown as SapMatchResponse;
}

export type SapMatchAction =
  | { action: "decide"; checkId: string; choice: string; reason?: string }
  | { action: "undo"; checkId: string }
  | {
      action: "allocate";
      lineIndex: number;
      allocations: Record<string, number>;
    }
  | { action: "reset-allocation"; lineIndex: number }
  | {
      action: "map-item";
      vendorCardCode: string;
      mappingKey: string;
      sapItemCode: string;
    }
  | { action: "map-vendor"; cardCode: string };

export async function postSapMatchAction(
  caseId: string,
  action: SapMatchAction,
) {
  const response = await apiFetch(
    `/api/cases/${encodeURIComponent(caseId)}/sap-match`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    },
  );
  const body = await readJson(response);
  return {
    ok: response.ok,
    error: response.ok ? null : errorText(body, "That did not work."),
  };
}

export async function fetchDraftHeaderPreview(
  caseId: string,
): Promise<DraftHeaderPreview> {
  const response = await apiFetch(
    `/api/cases/${encodeURIComponent(caseId)}/sap-match/draft`,
  );
  const body = await readJson(response);
  if (!response.ok || !body.preview)
    throw new Error(errorText(body, "Could not load the draft fields."));
  return body.preview as DraftHeaderPreview;
}

export async function createMatchedSapDraft(
  caseId: string,
  choices: DraftFieldChoices = {},
) {
  const response = await apiFetch(
    `/api/cases/${encodeURIComponent(caseId)}/sap-match/draft`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(choices),
    },
  );
  const body = await readJson(response);
  return {
    ok: response.ok,
    message:
      typeof body.message === "string" && body.message
        ? body.message
        : response.ok
          ? "SAP Test AP Invoice Draft created. No invoice was posted."
          : errorText(body, "Draft creation failed."),
  };
}

export type SapItemChoice = {
  itemCode: string;
  name: string;
  inventory: boolean | null;
};

export async function searchSapItems(
  caseId: string,
  query: string,
): Promise<SapItemChoice[]> {
  const response = await apiFetch(
    `/api/cases/${encodeURIComponent(caseId)}/sap-match/items?q=${encodeURIComponent(query)}`,
    { cache: "no-store" },
  );
  const body = await readJson(response);
  if (!response.ok)
    throw new Error(errorText(body, "Could not search SAP items."));
  return Array.isArray(body.items) ? (body.items as SapItemChoice[]) : [];
}

export async function fetchSapMatchRules(): Promise<MatchRules> {
  const response = await apiFetch("/api/settings/sap-match", {
    cache: "no-store",
  });
  const body = await readJson(response);
  if (!response.ok)
    throw new Error(errorText(body, "Could not load SAP matching rules."));
  if (!body.rules || typeof body.rules !== "object")
    throw new Error("Could not load SAP matching rules.");
  return body.rules as MatchRules;
}

export async function saveSapMatchRules(rules: MatchRules) {
  const response = await apiFetch("/api/settings/sap-match", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rules),
  });
  const body = await readJson(response);
  return {
    ok: response.ok,
    error: response.ok ? null : errorText(body, "Could not save the rules."),
  };
}

export type SapVendorChoice = { cardCode: string; cardName: string };

export async function searchSapVendors(
  caseId: string,
  query: string,
): Promise<SapVendorChoice[]> {
  const response = await apiFetch(
    `/api/cases/${encodeURIComponent(caseId)}/sap-match/vendors?q=${encodeURIComponent(query)}`,
    { cache: "no-store" },
  );
  const body = await readJson(response);
  if (!response.ok)
    throw new Error(errorText(body, "Could not search SAP vendors."));
  return Array.isArray(body.vendors) ? (body.vendors as SapVendorChoice[]) : [];
}
