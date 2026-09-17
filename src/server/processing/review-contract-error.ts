export class ReviewContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewContractError";
  }
}
