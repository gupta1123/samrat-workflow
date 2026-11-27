import { readComparisonOptions } from "@/lib/comparison";
import type { CaseAnalysisMode } from "@/types/pipeline";

export function needsInvoiceVerification(input: {
  available: boolean;
  recoveryAction?: "reanalyze";
  reason?: string;
}) {
  if (input.available) return false;
  if (input.recoveryAction === "reanalyze") return true;
  // Older saved jobs predate the explicit recovery action. Do not mistake
  // ordinary missing SAP receipts or line mismatches for extraction failures.
  return /invoice assembly|invoice page assembly|invoice item extraction is incomplete|source-reviewed invoice assembly/i.test(
    input.reason ?? "",
  );
}

type RecoveryDependencies = {
  read: (id: string) => Promise<{
    case: {
      id: string;
      status: string;
      processingMeta?: Record<string, unknown>;
    };
    files: unknown[];
  }>;
  enqueue: (
    id: string,
    options: {
      analysisMode: CaseAnalysisMode;
      comparisonOptions: ReturnType<typeof readComparisonOptions>;
    },
  ) => Promise<unknown>;
};

/** Uses the existing owned, durable analysis queue; never retries SAP alone. */
export async function retryInvoiceVerification(
  caseId: string,
  dependencies?: RecoveryDependencies,
) {
  const deps: RecoveryDependencies = dependencies ?? {
    read: async (id) =>
      (await import("@/lib/case-persistence")).fetchCaseDetail(id),
    enqueue: async (id, options) =>
      (await import("@/lib/case-persistence")).enqueueCaseAnalysis(id, options),
  };
  const detail = await deps.read(caseId);
  if (detail.case.id !== caseId) throw new Error("Case could not be loaded.");
  if (detail.case.status === "processing") return; // navigate to the existing job
  if (
    !["completed", "failed"].includes(detail.case.status) ||
    !detail.files.length
  )
    throw new Error(
      "Open this case and check its documents before trying again.",
    );
  const meta = detail.case.processingMeta;
  await deps.enqueue(caseId, {
    analysisMode:
      meta?.analysisMode === "smart_split" ? "smart_split" : "standard",
    comparisonOptions: readComparisonOptions(meta?.comparisonOptions),
  });
}
