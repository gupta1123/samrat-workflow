import { ApiError } from "@/server/api/helpers";
import {
  readSapEnvironment,
  sapCaseEnvironment,
  sapEnvironmentLabel,
  type SapEnvironment,
} from "./config";

export function requireActiveSapCase(createdAt: unknown): SapEnvironment {
  const environment = sapCaseEnvironment(createdAt);
  if (environment !== readSapEnvironment()) {
    throw new ApiError(
      `This case belongs to ${sapEnvironmentLabel(environment)}. Its SAP history is read-only while the other environment is active.`,
      409,
    );
  }
  return environment;
}

export function isSapMatchForEnvironment(
  match: { sapEnv?: SapEnvironment } | null | undefined,
  environment: SapEnvironment,
) {
  return !!match && (match.sapEnv ?? "test") === environment;
}
