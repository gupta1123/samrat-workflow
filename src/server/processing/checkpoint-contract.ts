export type ReviewCheckpointStage =
  "extraction" | "source" | "packet" | "decisions" | "root-causes";

// Field roles and row structures changed: old extraction/review checkpoints
// cannot be reused as if they satisfy this contract.
export const EXTRACTION_CHECKPOINT_CONTRACT_VERSION =
  "lossless-source-page-fields-v15";

export const STAGED_REVIEW_CONTRACT_VERSION =
  "source-bound-logistics-applicability-v24";

export function checkpointContractForStage(stage: ReviewCheckpointStage) {
  return stage === "extraction"
    ? EXTRACTION_CHECKPOINT_CONTRACT_VERSION
    : STAGED_REVIEW_CONTRACT_VERSION;
}
