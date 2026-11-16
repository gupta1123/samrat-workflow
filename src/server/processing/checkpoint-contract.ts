export type ReviewCheckpointStage =
  "extraction" | "source" | "packet" | "decisions" | "root-causes";

// Rebuild older source views and readability verdicts after orientation changes.
export const EXTRACTION_CHECKPOINT_CONTRACT_VERSION =
  "lossless-source-page-fields-v16";

export const STAGED_REVIEW_CONTRACT_VERSION =
  "source-bound-invoice-reconciliation-v26";

export function checkpointContractForStage(stage: ReviewCheckpointStage) {
  return stage === "extraction"
    ? EXTRACTION_CHECKPOINT_CONTRACT_VERSION
    : STAGED_REVIEW_CONTRACT_VERSION;
}
