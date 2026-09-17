type AnalysisProgressJob = {
  status: string;
  attemptCount: number;
  maxAttempts: number;
  progress: number;
  lockedAt?: string | null;
  updatedAt?: string | null;
  nextRunAt?: string | null;
};

function validTime(value: string | null | undefined) {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

function durationLabel(seconds: number) {
  if (seconds < 90) return "about a minute";
  const minutes = Math.max(2, Math.round(seconds / 60));
  return `about ${minutes} minutes`;
}

function retryTimeLabel(nextRunAt: string | null | undefined, now: number) {
  const retryAt = validTime(nextRunAt);
  if (retryAt === null || retryAt <= now + 1_000) return "shortly";
  const seconds = Math.ceil((retryAt - now) / 1_000);
  if (seconds < 90) return `in about ${seconds} seconds`;
  return `in about ${Math.ceil(seconds / 60)} minutes`;
}

export function getAnalysisProgressNotice(
  job: AnalysisProgressJob | null | undefined,
  now = Date.now(),
) {
  if (!job) return "Waiting for an analysis worker to accept this case.";

  if (job.status === "queued") {
    if (job.attemptCount > 0) {
      const nextAttempt = Math.min(job.attemptCount + 1, job.maxAttempts);
      return `The previous attempt did not finish. Automatic retry ${nextAttempt} of ${job.maxAttempts} will start ${retryTimeLabel(job.nextRunAt, now)}.`;
    }
    return "Waiting for an analysis worker to start.";
  }

  if (job.status !== "running") return null;

  const activityAt = validTime(job.lockedAt) ?? validTime(job.updatedAt);
  const inactivitySeconds = activityAt
    ? Math.max(0, Math.floor((now - activityAt) / 1_000))
    : 0;

  if (activityAt && inactivitySeconds >= 45) {
    return `Analysis is delayed: the worker has not reported activity for ${durationLabel(inactivitySeconds)}. Samrat will retry automatically if it does not recover.`;
  }

  if (job.progress >= 88) {
    return "The final AI review is active. Complex packets can take several minutes; worker activity is still being received.";
  }

  if (job.attemptCount > 1) {
    return `Automatic retry ${job.attemptCount} of ${job.maxAttempts} is now running.`;
  }

  return null;
}

export function getFriendlyAnalysisError(error: string | null | undefined) {
  if (!error) return "Case analysis failed.";
  if (
    /did not return a json object|authoritative packet review did not return|independent extraction validation/i.test(
      error,
    )
  )
    return "The final AI review returned an incomplete response. Samrat did not save uncertain results. Please retry the analysis.";
  if (/timed out|time limit|stopped reporting activity/i.test(error))
    return "Analysis took too long and was stopped safely. Please retry; if it happens again, use fewer pages.";
  if (/quota|credits|billing|insufficient/i.test(error))
    return "The AI provider has no available credits or quota. Recharge or update the provider account, then retry the analysis.";
  return error;
}
