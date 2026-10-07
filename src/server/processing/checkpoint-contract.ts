export type ReviewCheckpointStage =
  "extraction" | "source" | "packet" | "decisions" | "root-causes";

// Extraction output is independent of the downstream review contract. Keep
// the current production value so failed v12 jobs can resume their already
// completed extraction after a review-only deployment.
export const EXTRACTION_CHECKPOINT_CONTRACT_VERSION =
  "all-packet-issues-root-cause-reviewed-v12";

export const STAGED_REVIEW_CONTRACT_VERSION =
  "byte-bounded-source-evidence-v16";

export function checkpointContractForStage(stage: ReviewCheckpointStage) {
  return stage === "extraction"
    ? EXTRACTION_CHECKPOINT_CONTRACT_VERSION
    : STAGED_REVIEW_CONTRACT_VERSION;
}
