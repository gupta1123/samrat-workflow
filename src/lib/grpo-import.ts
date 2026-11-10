export type GrpoSapDraftState = {
  status: "created" | "not_created" | "posted" | "unavailable";
  docEntry?: string;
  docNum?: string;
};

export type GrpoUploadState = {
  caseId: string;
  status: string;
  deleted: boolean;
  sapDraft?: GrpoSapDraftState;
};
export type GrpoImportSource = {
  environment: "test";
  company: string;
  docEntry: number;
  docNum: number;
};
export type GrpoImportResult = {
  caseId: string;
  status: string;
  deleted?: boolean;
};

export type GrpoPdfAvailability = {
  status: "available" | "missing" | "unavailable";
  count?: number;
};
