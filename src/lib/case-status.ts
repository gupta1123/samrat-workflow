export type CaseStatusTone =
  "neutral" | "warning" | "processing" | "success" | "danger";

export type CaseDisplayStatus = {
  label: string;
  tone: CaseStatusTone;
  hasFinalDecision: boolean;
};

export function getCaseDisplayStatus(status: string): CaseDisplayStatus {
  if (status === "accepted") {
    return { label: "Approved", tone: "success", hasFinalDecision: true };
  }
  if (status === "rejected") {
    return { label: "Rejected", tone: "danger", hasFinalDecision: true };
  }
  if (status === "completed") {
    return {
      label: "Needs Review",
      tone: "warning",
      hasFinalDecision: false,
    };
  }
  if (status === "processing") {
    return {
      label: "Processing",
      tone: "processing",
      hasFinalDecision: false,
    };
  }
  if (status === "failed") {
    return { label: "Failed", tone: "danger", hasFinalDecision: false };
  }
  if (status === "draft") {
    return { label: "Draft", tone: "neutral", hasFinalDecision: false };
  }
  return { label: "Needs Review", tone: "warning", hasFinalDecision: false };
}
