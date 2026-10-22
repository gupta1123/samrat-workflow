const DEFAULT_SUPABASE_FETCH_TIMEOUT_MS = 20_000;

export function createSupabaseFetch(
  timeoutMs = DEFAULT_SUPABASE_FETCH_TIMEOUT_MS,
  fetcher: typeof fetch = (...args) => fetch(...args),
): typeof fetch {
  return async function supabaseFetch(input, init) {
    const controller = new AbortController();
    const callerSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const timeout = setTimeout(
      () =>
        controller.abort(
          new DOMException(
            "The connection timed out. Please try again.",
            "TimeoutError",
          ),
        ),
      timeoutMs,
    );
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(controller.signal.reason),
        { once: true },
      );
    });

    const abortFromCaller = () => controller.abort(callerSignal?.reason);

    if (callerSignal?.aborted) {
      abortFromCaller();
    } else {
      callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    try {
      return await Promise.race([
        (async () => {
          controller.signal.throwIfAborted();
          const response = await fetcher(input, {
            ...init,
            signal: controller.signal,
          });
          // Supabase consumes JSON after fetch resolves. Keep the deadline active
          // until the entire body has arrived, not just the response headers.
          const body = response.body ? await response.arrayBuffer() : null;
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        })(),
        cancelled,
      ]);
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  };
}
