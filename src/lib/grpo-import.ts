export type GrpoUploadState = {
  caseId: string;
  status: string;
  deleted: boolean;
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
