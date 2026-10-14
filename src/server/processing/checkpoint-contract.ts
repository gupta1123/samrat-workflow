export type ReviewCheckpointStage =
  "extraction" | "source" | "packet" | "decisions" | "root-causes";

// Field roles and row structures changed: old extraction/review checkpoints
// cannot be reused as if they satisfy this contract.
export const EXTRACTION_CHECKPOINT_CONTRACT_VERSION =
  "service-aware-source-fields-v14";

export const STAGED_REVIEW_CONTRACT_VERSION =
  "source-grounded-invoice-assembly-v22";

export function checkpointContractForStage(stage: ReviewCheckpointStage) {
  return stage === "extraction"
    ? EXTRACTION_CHECKPOINT_CONTRACT_VERSION
    : STAGED_REVIEW_CONTRACT_VERSION;
}
