import { AsyncLocalStorage } from "node:async_hooks";
const deadlines = new AsyncLocalStorage<number>();
export function withProcessingDeadline<T>(work: () => Promise<T>) {
  return deadlines.run(Date.now() + 13 * 60 * 1000, work);
}
export function remainingTimeout(requested = 60000) {
  const remaining =
    (deadlines.getStore() ?? Date.now() + requested) - Date.now();
  if (remaining < 1000)
    throw new Error(
      "Processing time limit reached. Split this case into fewer pages.",
    );
  return Math.max(1, Math.min(requested, remaining));
}
