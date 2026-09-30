export type SourceReviewValidationSection =
  "references" | "field-changes" | "source-audit";

export class SourceReviewValidationError extends Error {
  constructor(
    readonly section: SourceReviewValidationSection,
    message: string,
  ) {
    super(message);
    this.name = "SourceReviewValidationError";
  }
}

export class ReviewContractError extends Error {
  operation?: string;
  defect?: string;
  rejected?: string;
  validationSection?: SourceReviewValidationSection;

  constructor(
    message: string,
    details: {
      operation?: string;
      defect?: string;
      rejected?: string;
      validationSection?: SourceReviewValidationSection;
    } = {},
  ) {
    super(message);
    this.name = "ReviewContractError";
    this.operation = details.operation;
    this.defect = details.defect;
    this.rejected = details.rejected;
    this.validationSection = details.validationSection;
  }
}
