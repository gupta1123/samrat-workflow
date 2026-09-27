import type { CaseAnalysisMode } from "@/types/pipeline";

export type AnalysisModeCopy = {
  title: string;
  retryTitle: string;
  description: string;
  dialogDescription: string;
};

export const ANALYSIS_MODE_COPY: Record<CaseAnalysisMode, AnalysisModeCopy> = {
  standard: {
    title: "Analyze as one case",
    retryTitle: "Retry as one case",
    description: "Documents for one purchase or shipment.",
    dialogDescription:
      "Samrat will keep all uploaded documents together as one case.",
  },
  smart_split: {
    title: "Split into separate cases",
    retryTitle: "Retry and split cases",
    description: "Documents for different purchases or shipments.",
    dialogDescription:
      "Samrat will identify unrelated document groups and create a separate case for each group.",
  },
};

export function getAnalysisModeTitle(mode: CaseAnalysisMode, retry = false) {
  const copy = ANALYSIS_MODE_COPY[mode];
  return retry ? copy.retryTitle : copy.title;
}
