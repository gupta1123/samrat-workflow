type AnalysisStartPayload = {
  case?: { status?: unknown } | null;
  job?: { id?: unknown; status?: unknown } | null;
};

type ConfirmedAnalysisStart<T extends AnalysisStartPayload> = T & {
  case: NonNullable<T["case"]> & { status: "processing" };
  job: NonNullable<T["job"]> & {
    id: string;
    status: "queued" | "running";
  };
};

export function isConfirmedAnalysisStart<T extends AnalysisStartPayload>(
  value: T | null | undefined,
): value is ConfirmedAnalysisStart<T> {
  if (!value || typeof value !== "object") return false;

  const payload = value as AnalysisStartPayload;
  return (
    payload.case?.status === "processing" &&
    typeof payload.job?.id === "string" &&
    payload.job.id.length > 0 &&
    (payload.job.status === "queued" || payload.job.status === "running")
  );
}
