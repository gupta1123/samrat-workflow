import { apiFetch } from "./api-client";
import { enqueueCaseAnalysis } from "./case-persistence";
import type { GrpoImportResult } from "./grpo-import";

type Prepared = Partial<GrpoImportResult> & {
  files?: Array<{ index: number; name: string }>;
  day?: string;
  manifest?: string;
  session?: string;
};
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
