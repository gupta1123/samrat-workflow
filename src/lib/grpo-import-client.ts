import { apiFetch } from "./api-client";
import { enqueueCaseAnalysis } from "./case-persistence";
import type {
  GrpoImportResult,
  GrpoPdfAvailability,
  GrpoUploadState,
} from "./grpo-import";
import type { SapInspectorRecord } from "./sap-inspector";

type OpenReceiptSnapshot = {
  records: SapInspectorRecord[];
  uploads: Record<string, GrpoUploadState>;
  pdfs: Record<string, GrpoPdfAvailability>;
};

export async function fetchOpenReceiptSnapshot(
  signal: AbortSignal,
  onProgress: (count: number) => void,
  fetcher = apiFetch,
): Promise<OpenReceiptSnapshot> {
  const records = new Map<string, SapInspectorRecord>();
  const uploads: OpenReceiptSnapshot["uploads"] = {};
  const pdfs: OpenReceiptSnapshot["pdfs"] = {};
  const params = new URLSearchParams({ uploaded: "all", limit: "70" });
  let cursor: number | null = null;

  do {
    signal.throwIfAborted();
    if (cursor !== null) params.set("before", String(cursor));
    const response = await fetcher(`/api/sap-inspector/open-grpos?${params}`, {
      cache: "no-store",
      signal,
    });
    const body = (await response.json().catch(() => null)) as
      | (OpenReceiptSnapshot & { nextCursor: number | null; error?: string })
      | null;
    signal.throwIfAborted();
    if (!response.ok) {
      throw new Error(
        body?.error || "Could not load unbilled receipts from SAP.",
      );
    }
    if (
      !body ||
      !Array.isArray(body.records) ||
      !body.uploads ||
      !body.pdfs ||
      (body.nextCursor !== null &&
        (!Number.isSafeInteger(body.nextCursor) ||
          body.nextCursor <= 0 ||
          (cursor !== null && body.nextCursor >= cursor)))
    ) {
      throw new Error("SAP returned an incomplete receipt list. Try again.");
    }
    for (const record of body.records) {
      if (!record.docEntry) {
        throw new Error("SAP returned a receipt without a document entry.");
      }
      records.set(record.docEntry, record);
      const upload = body.uploads[record.docEntry];
      const pdf = body.pdfs[record.docEntry];
      if (upload) uploads[record.docEntry] = upload;
      else delete uploads[record.docEntry];
      if (pdf) pdfs[record.docEntry] = pdf;
      else delete pdfs[record.docEntry];
    }
    cursor = body.nextCursor;
    onProgress(records.size);
  } while (cursor !== null);

  return { records: [...records.values()], uploads, pdfs };
}

type Prepared = Partial<GrpoImportResult> & {
  files?: Array<{ index: number; name: string }>;
  day?: string;
  manifest?: string;
  session?: string;
};

export async function recycleImportedGrpo(
  entry: string,
  caseId: string,
  fetcher = apiFetch,
) {
  const response = await fetcher(
    `/api/sap-inspector/grpos/${encodeURIComponent(entry)}/import`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseId }),
    },
  );
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error || "Could not move the case to Recycle Bin.");
  if (body.caseId !== caseId || body.deleted !== true)
    throw new Error(
      "Deletion could not be confirmed. Refresh to check the case.",
    );
}

export async function importGrpoAndAnalyze(
  entry: string,
  progress: (label: string) => void,
  deps = { fetcher: apiFetch, enqueue: enqueueCaseAnalysis },
) {
  const post = async (body: Record<string, unknown>): Promise<Prepared> => {
    const r = await deps.fetcher(
      `/api/sap-inspector/grpos/${encodeURIComponent(entry)}/import`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(75_000),
      },
    );
    const b = await r.json();
    if (!r.ok) throw new Error(b.error || "SAP import failed. Retry.");
    return b;
  };
  progress("Checking SAP PDFs…");
  const prepared = await post({ action: "prepare" });
  let result = prepared;
  if (!prepared.caseId) {
    if (
      !prepared.files?.length ||
      !prepared.day ||
      !prepared.manifest ||
      !prepared.session
    )
      throw new Error("SAP did not return any PDFs.");
    const session = {
      day: prepared.day,
      manifest: prepared.manifest,
      session: prepared.session,
    };
    for (const [i, file] of prepared.files.entries()) {
      progress(
        `Downloading and saving PDF ${i + 1} of ${prepared.files.length}…`,
      );
      const saved = await post({
        action: "file",
        ...session,
        index: file.index,
      });
      if (saved.caseId) {
        result = saved;
        break;
      }
    }
    if (!result.caseId) {
      progress("Creating case…");
      result = await post({ action: "finish", ...session });
    }
  }
  if (!result.caseId || !result.status)
    throw new Error("The saved case could not be confirmed. Retry.");
  if (result.deleted)
    throw new Error(
      "This GRPO's case is in Recycle Bin. Restore the case to continue.",
    );
  if (result.status === "draft" || result.status === "failed") {
    progress("Starting analysis…");
    try {
      await deps.enqueue(result.caseId, {});
      result.status = "processing";
    } catch {
      throw new GrpoAnalysisStartError(result.caseId);
    }
  }
  return result as GrpoImportResult;
}
export class GrpoAnalysisStartError extends Error {
  constructor(public caseId: string) {
    super(
      "PDFs are uploaded, but analysis did not start. Open the case or retry analysis from the Uploaded tab.",
    );
  }
}
