import type { SapMatchResponse } from "./sap-match-client";

type Posting = {
  kind: string;
  status: string;
  sap_env: string;
  sap_docnum: string | null;
};

export function findPostedApInvoice<T extends Posting>(
  postings: readonly T[],
  environment: string,
): (T & { status: "posted"; sap_docnum: string }) | null {
  const posting = postings.find(
    (item) =>
      item.kind === "AP" &&
      item.status === "posted" &&
      item.sap_env === environment &&
      typeof item.sap_docnum === "string" &&
      item.sap_docnum.trim().length > 0,
  );
  return (
    (posting as (T & { status: "posted"; sap_docnum: string }) | undefined) ??
    null
  );
}

export function needsSapMatchPolling(
  response: SapMatchResponse | null,
): boolean {
  return Boolean(
    response &&
    !findPostedApInvoice(response.postings, response.sapEnv) &&
    (response.matchJob?.status === "queued" ||
      response.matchJob?.status === "running"),
  );
}

// Schedule the next check after the previous response, even when its job fields
// have not changed. One request at a time; cleanup also stops an in-flight loop.
export function pollSapMatch(
  load: () => Promise<SapMatchResponse | null>,
  onError: (error: unknown) => void,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function tick() {
    timer = undefined;
    try {
      const response = await load();
      if (!stopped && needsSapMatchPolling(response)) schedule();
    } catch (error) {
      if (!stopped) onError(error);
    }
  }

  function schedule() {
    timer = setTimeout(() => void tick(), 2_000);
  }

  schedule();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
