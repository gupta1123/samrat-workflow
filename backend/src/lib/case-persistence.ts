import { apiFetch } from "@/lib/api-client";
import type { PacketIntelligence } from "@/lib/packet-intelligence";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { getQueuedUploadFiles } from "@/lib/upload-groups";
import { validateCasePageLimit } from "@/lib/upload-page-limit";
import { isConfirmedAnalysisStart } from "@/lib/analysis-start";
import type {
  CaseAnalysisMode,
  CommercialLineItem,
  ComparisonOptions,
  QueuedUpload,
} from "@/types/pipeline";
import type { DraftCaseFile } from "@/lib/draft-case-files";

export type SavedCaseRecord = {
  id: string;
  slug: string;
  displayName: string;
  buyerName: string | null;
  receiverName: string | null;
  category: string;
  poNumber: string | null;
  invoiceNumber: string | null;
  status: string;
  riskScore: number;
  uploadCount: number;
  documentCount: number;
  mismatchCount: number;
  createdAt: string;
  deletedAt: string | null;
};

export type DuplicateCaseReference = {
  id: string;
  displayName: string;
  status: string;
  createdAt: string;
};

export type ShipmentBatchCase = {
  id: string;
  displayName: string;
  buyerName: string | null;
  invoiceNumber: string | null;
  status: string;
  documentCount: number;
  mismatchCount: number;
  shipmentIndex: number;
  isCurrent: boolean;
};

export type SavedCaseFile = {
  id: string;
  originalName: string;
  storageBucket: string;
  storagePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string;
  signedUrl: string | null;
};

export type SavedCaseDocument = {
  id: string;
  clientDocumentId: string | null;
  sourceFileName: string | null;
  sourceHint: string | null;
  documentType: string;
  title: string;
  pageCount: number;
  extractedFields: Record<string, unknown>;
  lineItems?: CommercialLineItem[];
  markdown: string;
  createdAt: string;
};

export type SavedCaseMismatch = {
  id: string;
  clientMismatchId: string | null;
  fieldName: string;
  values: Array<{
    docId?: string;
    value?: string | number | null;
    isOutlier?: boolean;
  }>;
  analysis: string | null;
  fixPlan: string | null;
  resolutionStatus: "pending" | "accepted" | "rejected";
  resolvedAt: string | null;
  createdAt: string;
};

export type SavedCaseDetail = {
  case: SavedCaseRecord & {
    processingMeta?: Record<string, unknown>;
  };
  files: SavedCaseFile[];
  documents: SavedCaseDocument[];
  mismatches: SavedCaseMismatch[];
  packetIntelligence?: PacketIntelligence | null;
  shipmentCases?: ShipmentBatchCase[];
};

export type SavedAnalysisJob = {
  id: string;
  caseId: string;
  jobType: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  progress: number;
  stage: string | null;
  error: string | null;
  result: Record<string, unknown>;
  lockedAt: string | null;
  lockedBy: string | null;
  nextRunAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type CreateCaseResponse = {
  case: SavedCaseRecord;
  files: DraftCaseFile[];
};

type CreateCaseApiResponse = {
  case?: SavedCaseRecord;
  files?: DraftCaseFile[];
  duplicateCase?: DuplicateCaseReference;
};

type EnqueueCaseAnalysisResponse = {
  case: SavedCaseRecord;
  job?: SavedAnalysisJob | null;
};

type CaseAnalysisStatusResponse = {
  caseStatus: string;
  job: SavedAnalysisJob | null;
};

export type MissingDocumentUploadFileDecision = {
  sourceFileName: string;
  decision: "accepted" | "rejected" | "needs_review";
  reason: string;
  detectedDocumentTypes: string[];
  satisfiedMissingGroups: string[];
  sameTransaction: boolean | null;
  confidence: "high" | "medium" | "low";
  createNewCaseSuggested: boolean;
};

export type MissingDocumentUploadResponse = {
  decision: "accepted" | "partially_accepted" | "rejected" | "needs_review";
  case: SavedCaseRecord | null;
  files: MissingDocumentUploadFileDecision[];
  acceptedFileNames: string[];
  rejectedFileNames: string[];
  satisfiedGroups: string[];
  remainingGroups: string[];
};

export type DocumentPageReplacementResponse = {
  decision: "accepted" | "rejected" | "needs_review";
  reason: string;
  target: {
    sourceFileName: string;
    pageNumber: number;
    documentId: string;
    issues: string[];
    reason: string;
  };
  revisionId?: string;
  case?: SavedCaseRecord;
  job?: SavedAnalysisJob | null;
};

type RecentCasesResponse = {
  cases: SavedCaseRecord[];
  nextCursor?: string | null;
  hasMore?: boolean;
  page?: number;
  pageSize?: number;
  totalCount?: number;
  totalPages?: number;
};

type CaseDetailResponse = SavedCaseDetail;
type CachedCaseDetail = {
  expiresAt: number;
  value: CaseDetailResponse;
};

const CASE_DETAIL_CACHE_TTL_MS = 15_000;
const caseDetailCache = new Map<string, CachedCaseDetail>();
const pendingCaseDetailReads = new Map<string, Promise<CaseDetailResponse>>();

function invalidateCaseDetailCache(caseId: string) {
  caseDetailCache.delete(caseId);
}

type CaseFileSignedUrlResponse = {
  fileId: string;
  signedUrl: string;
};
export type CaseListScope = "active" | "deleted";
export type CaseDecision = "accepted" | "rejected";
export type MismatchDecision = "accepted" | "rejected";

export type FetchCasesOptions = {
  scope: CaseListScope;
  limit?: number;
  cursor?: string | null;
  page?: number | null;
  query?: string;
  sortMode?: "recent" | "oldest" | "name";
  statusFilter?: "all" | "pending" | "in_review" | "completed" | "failed";
  signal?: AbortSignal;
};

type UpdateCaseMismatchDecisionResponse = {
  caseStatus: string;
  mismatch: {
    id: string;
    resolutionStatus: "pending" | "accepted" | "rejected";
    resolvedAt: string | null;
  };
};

type UpdateCaseMismatchDecisionsResponse = {
  caseStatus: string;
  mismatches: Array<{
    id: string;
    resolutionStatus: "pending" | "accepted" | "rejected";
    resolvedAt: string | null;
  }>;
};

const AUTH_SESSION_ERROR =
  "Your session is not active on this device. Sign in again to continue.";

class ApiRequestError extends Error {
  status?: number;
  isAuthError: boolean;
  duplicateCase?: DuplicateCaseReference;

  constructor(
    message: string,
    options?: {
      status?: number;
      isAuthError?: boolean;
      duplicateCase?: DuplicateCaseReference;
    },
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.status = options?.status;
    this.isAuthError = Boolean(options?.isAuthError);
    this.duplicateCase = options?.duplicateCase;
  }
}

export function getDuplicateCaseFromError(error: unknown) {
  return error instanceof ApiRequestError
    ? (error.duplicateCase ?? null)
    : null;
}

const signedUploads = new WeakMap<
  File,
  { expiresAt: number; promise: Promise<string> }
>();
async function uploadFiles(uploads: QueuedUpload[]) {
  const files = uploads.flatMap(getQueuedUploadFiles);
  if (!files.length || files.length > 20)
    throw new Error("Select between 1 and 20 files.");
  if (new Set(files.map((f) => f.name.toLowerCase())).size !== files.length)
    throw new Error("Give each file a different name before uploading.");
  if (files.reduce((sum, f) => sum + f.size, 0) > 100 * 1024 * 1024)
    throw new Error("A case can contain up to 100 MB of files.");
  await validateCasePageLimit(files);
  const ids: string[] = [];
  for (const file of files) {
    let cached = signedUploads.get(file);
    if (!cached || cached.expiresAt < Date.now()) {
      const promise = (async () => {
        const digest = await crypto.subtle.digest(
          "SHA-256",
          await file.arrayBuffer(),
        );
        const sha256 = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const response = await performApiFetch("/api/uploads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, size: file.size, sha256 }),
        });
        const payload = await response.json();
        if (!response.ok)
          throw toApiRequestError(payload, "Could not prepare upload.", {
            status: response.status,
          });
        const { error } = await createSupabaseBrowserClient()
          .storage.from("packet-files")
          .uploadToSignedUrl(payload.path, payload.token, file, {
            contentType: file.type || "application/octet-stream",
          });
        if (error)
          throw new Error(
            "Upload failed for " +
              file.name +
              ". Check your connection and retry.",
          );
        return payload.id as string;
      })().catch((error) => {
        signedUploads.delete(file);
        throw error;
      });
      cached = { promise, expiresAt: Date.now() + 90 * 60 * 1000 };
      signedUploads.set(file, cached);
    }
    ids.push(await cached.promise);
  }
  return ids;
}

async function readApiResponse<T>(response: Response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const payload = (await response.json().catch(() => ({}))) as Partial<T> & {
      error?: unknown;
    };

    return {
      payload,
      rawText: "",
    };
  }

  return {
    payload: {} as Partial<T> & { error?: unknown },
    rawText: await response.text().catch(() => ""),
  };
}

async function performApiFetch(input: RequestInfo | URL, init?: RequestInit) {
  try {
    return await apiFetch(String(input), init);
  } catch {
    throw new ApiRequestError(
      "Unable to reach the server. Check your connection and try again.",
    );
  }
}

function isAuthErrorPayload(payload: unknown, status?: number) {
  if (status === 401 || status === 403) {
    return true;
  }

  if (!payload || typeof payload !== "object") {
    return false;
  }

  const errorValue = (payload as { error?: unknown }).error;

  if (typeof errorValue === "string") {
    return /unauthorized|forbidden|session|auth/i.test(errorValue);
  }

  if (errorValue && typeof errorValue === "object") {
    const record = errorValue as Record<string, unknown>;
    const combined = [record.message, record.details, record.hint]
      .filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
      .join(" ");

    return /unauthorized|forbidden|session|auth/i.test(combined);
  }

  return false;
}

function redirectToLogin(message: string) {
  if (typeof window === "undefined") {
    return;
  }

  const loginUrl = new URL("/login", window.location.origin);
  const next = `${window.location.pathname}${window.location.search}`;

  if (next && next !== "/login") {
    loginUrl.searchParams.set("next", next);
  }

  loginUrl.searchParams.set("message", message);
  window.location.assign(loginUrl.toString());
}

function extractApiError(
  payload: unknown,
  fallback: string,
  options?: { status?: number; rawText?: string },
) {
  if (isAuthErrorPayload(payload, options?.status)) {
    return AUTH_SESSION_ERROR;
  }

  if (!payload || typeof payload !== "object") {
    const rawText = options?.rawText?.trim() || "";

    if (
      options?.status === 413 ||
      /payload|request entity too large|body exceeded|content length/i.test(
        rawText,
      )
    ) {
      return "Selected image is too large to upload. Try again after using a smaller image or fewer pages.";
    }

    return fallback;
  }

  const errorValue = (payload as { error?: unknown }).error;
  if (typeof errorValue === "string" && errorValue.trim().length > 0) {
    return errorValue;
  }

  if (errorValue && typeof errorValue === "object") {
    const record = errorValue as Record<string, unknown>;
    const parts = [record.message, record.details, record.hint].filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    );

    if (parts.length > 0) {
      return parts.join(" ");
    }
  }

  if (
    options?.status === 413 ||
    /payload|request entity too large|body exceeded|content length/i.test(
      options?.rawText || "",
    )
  ) {
    return "Selected image is too large to upload. Try again after using a smaller image or fewer pages.";
  }

  return fallback;
}

function readDuplicateCase(
  payload: unknown,
): DuplicateCaseReference | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const duplicateCase = (payload as { duplicateCase?: unknown }).duplicateCase;
  if (!duplicateCase || typeof duplicateCase !== "object") {
    return undefined;
  }

  const record = duplicateCase as Partial<DuplicateCaseReference>;
  return typeof record.id === "string" &&
    typeof record.displayName === "string" &&
    typeof record.status === "string" &&
    typeof record.createdAt === "string"
    ? {
        id: record.id,
        displayName: record.displayName,
        status: record.status,
        createdAt: record.createdAt,
      }
    : undefined;
}

function toApiRequestError(
  payload: unknown,
  fallback: string,
  options?: { status?: number; rawText?: string },
) {
  const isAuthError = isAuthErrorPayload(payload, options?.status);
  const message = extractApiError(payload, fallback, options);
  const duplicateCase = readDuplicateCase(payload);

  if (isAuthError) {
    redirectToLogin(message);
  }

  return new ApiRequestError(message, {
    status: options?.status,
    isAuthError,
    duplicateCase,
  });
}

export async function createDraftCase(params: {
  uploads: QueuedUpload[];
  allowDuplicate?: boolean;
}): Promise<CreateCaseResponse> {
  const uploadIds = await uploadFiles(params.uploads);
  const response = await performApiFetch("/api/cases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadIds, allowDuplicate: params.allowDuplicate }),
  });

  const { payload, rawText } =
    await readApiResponse<CreateCaseApiResponse>(response);

  if (!response.ok || !payload.case || !Array.isArray(payload.files)) {
    throw toApiRequestError(payload, "Failed to create draft case.", {
      status: response.status,
      rawText,
    });
  }

  return { case: payload.case, files: payload.files };
}

export async function appendCaseFiles(
  caseId: string,
  uploads: QueuedUpload[],
  mode: "append" | "overwrite" = "append",
): Promise<CreateCaseResponse> {
  const uploadIds = await uploadFiles(uploads);
  const response = await performApiFetch(`/api/cases/${caseId}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadIds, mode }),
  });

  const { payload, rawText } =
    await readApiResponse<CreateCaseResponse>(response);

  if (!response.ok || !payload.case || !Array.isArray(payload.files)) {
    throw toApiRequestError(payload, "Failed to add files to case.", {
      status: response.status,
      rawText,
    });
  }

  invalidateCaseDetailCache(caseId);
  return { case: payload.case, files: payload.files };
}

export async function removeDraftCaseFile(
  caseId: string,
  fileId: string,
): Promise<CreateCaseResponse> {
  const search = new URLSearchParams({ fileId });
  const response = await performApiFetch(
    `/api/cases/${caseId}/files?${search.toString()}`,
    { method: "DELETE" },
  );
  const { payload, rawText } =
    await readApiResponse<CreateCaseResponse>(response);
  if (!response.ok || !payload.case || !Array.isArray(payload.files)) {
    throw toApiRequestError(payload, "Failed to remove document.", {
      status: response.status,
      rawText,
    });
  }
  invalidateCaseDetailCache(caseId);
  return { case: payload.case, files: payload.files };
}

export type RemoveAnalyzedCaseFileResponse = {
  case: SavedCaseRecord;
  job?: SavedAnalysisJob | null;
  files?: SavedCaseFile[];
  warning?: string;
};

export async function removeAnalyzedCaseFile(
  caseId: string,
  fileId: string,
): Promise<RemoveAnalyzedCaseFileResponse> {
  const response = await performApiFetch(`/api/cases/${caseId}/files`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId }),
  });
  const { payload, rawText } =
    await readApiResponse<RemoveAnalyzedCaseFileResponse>(response);
  if (!response.ok || !payload.case) {
    throw toApiRequestError(payload, "Failed to remove document.", {
      status: response.status,
      rawText,
    });
  }
  invalidateCaseDetailCache(caseId);
  return {
    case: payload.case,
    job: payload.job ?? null,
    files: payload.files,
    warning: payload.warning,
  };
}

export async function replaceDraftCaseFile(
  caseId: string,
  fileId: string,
  upload: QueuedUpload,
): Promise<CreateCaseResponse> {
  const uploadIds = await uploadFiles([upload]);
  const response = await performApiFetch(`/api/cases/${caseId}/files`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId, uploadIds }),
  });
  const { payload, rawText } =
    await readApiResponse<CreateCaseResponse>(response);
  if (!response.ok || !payload.case || !Array.isArray(payload.files)) {
    throw toApiRequestError(payload, "Failed to replace document.", {
      status: response.status,
      rawText,
    });
  }
  invalidateCaseDetailCache(caseId);
  return { case: payload.case, files: payload.files };
}

export async function validateAndAppendMissingCaseFiles(
  caseId: string,
  uploads: QueuedUpload[],
): Promise<MissingDocumentUploadResponse> {
  const uploadIds = await uploadFiles(uploads);
  const response = await performApiFetch(
    `/api/cases/${caseId}/missing-documents`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadIds }),
    },
  );
  const { payload, rawText } =
    await readApiResponse<MissingDocumentUploadResponse>(response);

  if (!response.ok || !Array.isArray(payload.files)) {
    throw toApiRequestError(
      payload,
      "The selected documents could not be verified and were not added.",
      { status: response.status, rawText },
    );
  }

  invalidateCaseDetailCache(caseId);
  return payload as MissingDocumentUploadResponse;
}

export async function verifyAndReplaceUnreadableCasePage(
  caseId: string,
  mismatchId: string,
  uploads: QueuedUpload[],
): Promise<DocumentPageReplacementResponse> {
  const uploadIds = await uploadFiles(uploads);
  const response = await performApiFetch(`/api/cases/${caseId}/replace-page`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadIds, mismatchId }),
  });
  const { payload, rawText } =
    await readApiResponse<DocumentPageReplacementResponse>(response);

  if (!response.ok || !payload.decision || !payload.reason || !payload.target) {
    throw toApiRequestError(
      payload,
      "The replacement page could not be verified, so the case was not changed.",
      { status: response.status, rawText },
    );
  }

  if (payload.decision === "accepted") invalidateCaseDetailCache(caseId);
  return payload as DocumentPageReplacementResponse;
}

export async function enqueueCaseAnalysis(
  caseId: string,
  params: {
    analysisMode?: CaseAnalysisMode;
    comparisonOptions?: ComparisonOptions;
  },
): Promise<EnqueueCaseAnalysisResponse> {
  const response = await performApiFetch(`/api/cases/${caseId}/analysis`, {
    method: "POST",
    // Keep the durable enqueue request alive if the user immediately navigates
    // away, closes the tab, or the page is replaced after clicking Analyze.
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  const { payload, rawText } =
    await readApiResponse<EnqueueCaseAnalysisResponse>(response);

  if (!response.ok || !isConfirmedAnalysisStart(payload)) {
    throw toApiRequestError(payload, "Failed to start case analysis.", {
      status: response.status,
      rawText,
    });
  }

  invalidateCaseDetailCache(caseId);
  return {
    case: payload.case,
    job: payload.job ?? null,
  };
}

export async function fetchCaseAnalysisStatus(
  caseId: string,
): Promise<CaseAnalysisStatusResponse> {
  const response = await performApiFetch(
    `/api/cases/${caseId}/analysis/status`,
    {
      cache: "no-store",
    },
  );

  const { payload, rawText } =
    await readApiResponse<CaseAnalysisStatusResponse>(response);
  if (!response.ok || typeof payload.caseStatus !== "string") {
    throw toApiRequestError(payload, "Failed to load case analysis status.", {
      status: response.status,
      rawText,
    });
  }

  return {
    caseStatus: payload.caseStatus,
    job: payload.job ?? null,
  };
}

export async function fetchRecentCases(
  limit = 12,
): Promise<RecentCasesResponse> {
  return fetchCasePage({ scope: "active", limit });
}

export async function fetchCasesByScope(
  scope: CaseListScope,
  limit = 100,
): Promise<RecentCasesResponse> {
  return fetchCasePage({ scope, limit });
}

export async function fetchCasePage({
  scope,
  limit = 25,
  cursor,
  page,
  query: searchQuery,
  sortMode,
  statusFilter,
  signal,
}: FetchCasesOptions): Promise<RecentCasesResponse> {
  const query = new URLSearchParams();
  query.set("limit", String(limit));
  query.set("scope", scope);
  if (cursor) {
    query.set("cursor", cursor);
  } else if (page && page > 0) {
    query.set("page", String(Math.floor(page)));
  }
  if (searchQuery?.trim()) {
    query.set("q", searchQuery.trim());
  }
  if (statusFilter && statusFilter !== "all") {
    query.set("status", statusFilter);
  }
  if (sortMode && sortMode !== "recent") {
    query.set("sort", sortMode);
  }

  const response = await performApiFetch(`/api/cases?${query.toString()}`, {
    cache: "no-store",
    signal,
  });
  const { payload, rawText } =
    await readApiResponse<RecentCasesResponse>(response);

  if (!response.ok || !Array.isArray(payload.cases)) {
    throw toApiRequestError(payload, "Failed to load saved cases.", {
      status: response.status,
      rawText,
    });
  }

  return {
    cases: payload.cases,
    nextCursor: payload.nextCursor ?? null,
    hasMore: Boolean(payload.hasMore),
    page: payload.page,
    pageSize: payload.pageSize,
    totalCount: payload.totalCount,
    totalPages: payload.totalPages,
  };
}

async function mutateCase(
  caseId: string,
  init: RequestInit,
  fallback: string,
  path = `/api/cases/${caseId}`,
): Promise<{ case: SavedCaseRecord }> {
  const response = await performApiFetch(path, init);
  const { payload, rawText } =
    await readApiResponse<CreateCaseResponse>(response);

  if (!response.ok || !payload.case) {
    throw toApiRequestError(payload, fallback, {
      status: response.status,
      rawText,
    });
  }

  invalidateCaseDetailCache(caseId);
  return { case: payload.case };
}

export async function recycleCase(caseId: string) {
  return mutateCase(
    caseId,
    { method: "DELETE" },
    "Failed to move case to the recycle bin.",
  );
}

export async function restoreCase(caseId: string) {
  return mutateCase(
    caseId,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore" }),
    },
    "Failed to restore case from the recycle bin.",
  );
}

export async function updateCaseDecision(
  caseId: string,
  decision: CaseDecision,
) {
  return mutateCase(
    caseId,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: decision === "accepted" ? "accept" : "reject",
      }),
    },
    `Failed to ${decision === "accepted" ? "accept" : "reject"} case.`,
  );
}

export async function updateCaseMismatchDecision(
  caseId: string,
  mismatchId: string,
  decision: MismatchDecision,
) {
  const response = await performApiFetch(
    `/api/cases/${caseId}/mismatches/${mismatchId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: decision === "accepted" ? "accept" : "reject",
      }),
    },
  );

  const { payload, rawText } =
    await readApiResponse<UpdateCaseMismatchDecisionResponse>(response);

  if (
    !response.ok ||
    typeof payload.caseStatus !== "string" ||
    !payload.mismatch ||
    typeof payload.mismatch.id !== "string"
  ) {
    throw toApiRequestError(
      payload,
      `Failed to ${decision === "accepted" ? "accept" : "reject"} issue.`,
      {
        status: response.status,
        rawText,
      },
    );
  }

  invalidateCaseDetailCache(caseId);
  return {
    caseStatus: payload.caseStatus,
    mismatch: payload.mismatch,
  };
}

export async function updateCaseMismatchDecisions(
  caseId: string,
  mismatchIds: string[],
  decision: MismatchDecision,
) {
  const response = await performApiFetch(`/api/cases/${caseId}/mismatches`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: decision === "accepted" ? "accept" : "reject",
      mismatchIds,
    }),
  });

  const { payload, rawText } =
    await readApiResponse<UpdateCaseMismatchDecisionsResponse>(response);

  if (
    !response.ok ||
    typeof payload.caseStatus !== "string" ||
    !Array.isArray(payload.mismatches)
  ) {
    throw toApiRequestError(
      payload,
      `Failed to ${decision === "accepted" ? "accept" : "reject"} selected issues.`,
      {
        status: response.status,
        rawText,
      },
    );
  }

  invalidateCaseDetailCache(caseId);
  return {
    caseStatus: payload.caseStatus,
    mismatches: payload.mismatches,
  };
}

export async function deleteCaseForever(caseId: string) {
  return mutateCase(
    caseId,
    { method: "DELETE" },
    "Failed to permanently delete case.",
    `/api/cases/${caseId}?mode=hard`,
  );
}

export async function fetchCaseDetail(
  caseId: string,
): Promise<CaseDetailResponse> {
  const response = await performApiFetch(`/api/cases/${caseId}`, {
    cache: "no-store",
  });
  const { payload, rawText } =
    await readApiResponse<CaseDetailResponse>(response);

  if (
    !response.ok ||
    !payload.case ||
    !Array.isArray(payload.files) ||
    !Array.isArray(payload.documents) ||
    !Array.isArray(payload.mismatches)
  ) {
    throw toApiRequestError(payload, "Failed to load case details.", {
      status: response.status,
      rawText,
    });
  }

  const detail = {
    case: payload.case,
    files: payload.files,
    documents: payload.documents,
    mismatches: payload.mismatches,
    packetIntelligence: payload.packetIntelligence ?? null,
    shipmentCases: Array.isArray(payload.shipmentCases)
      ? payload.shipmentCases
      : [],
  };

  caseDetailCache.set(caseId, {
    expiresAt: Date.now() + CASE_DETAIL_CACHE_TTL_MS,
    value: detail,
  });
  return detail;
}

// Reuse a very recent detail response when development Strict Mode mounts a
// screen twice or when the user moves directly from detail to mismatch review.
// Authoritative refreshes still call fetchCaseDetail(), and every mutation
// invalidates this short-lived entry.
export async function fetchCaseDetailPreferCache(caseId: string) {
  const cached = caseDetailCache.get(caseId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  if (cached) {
    caseDetailCache.delete(caseId);
  }

  const pending = pendingCaseDetailReads.get(caseId);
  if (pending) return pending;

  const request = fetchCaseDetail(caseId).finally(() => {
    pendingCaseDetailReads.delete(caseId);
  });
  pendingCaseDetailReads.set(caseId, request);
  return request;
}

export async function fetchCaseFileSignedUrl(
  caseId: string,
  fileId: string,
): Promise<CaseFileSignedUrlResponse> {
  const searchParams = new URLSearchParams({ fileId });
  const response = await performApiFetch(
    `/api/cases/${caseId}/files?${searchParams.toString()}`,
    {
      cache: "no-store",
    },
  );
  const { payload, rawText } =
    await readApiResponse<CaseFileSignedUrlResponse>(response);

  if (
    !response.ok ||
    typeof payload.fileId !== "string" ||
    typeof payload.signedUrl !== "string"
  ) {
    throw toApiRequestError(payload, "Failed to load source preview.", {
      status: response.status,
      rawText,
    });
  }

  return {
    fileId: payload.fileId,
    signedUrl: payload.signedUrl,
  };
}

const signedUrlCache = new Map<string, CaseFileSignedUrlResponse>();

export async function fetchCaseFileSignedUrlPreferCache(
  caseId: string,
  fileId: string,
) {
  const cacheKey = `${caseId}:${fileId}`;
  const cached = signedUrlCache.get(cacheKey);
  if (cached) return cached;
  const payload = await fetchCaseFileSignedUrl(caseId, fileId);
  signedUrlCache.set(cacheKey, payload);
  return payload;
}
