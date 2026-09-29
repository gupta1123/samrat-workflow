export class ReviewContractError extends Error {
  operation?: string;
  defect?: string;
  rejected?: string;

  constructor(
    message: string,
    details: { operation?: string; defect?: string; rejected?: string } = {},
  ) {
    super(message);
    this.name = "ReviewContractError";
    this.operation = details.operation;
    this.defect = details.defect;
    this.rejected = details.rejected;
  }
}
