import { createSupabaseFetch } from "./fetch";

export const AUTH_PROXY_PATH = "/api/auth/";
const AUTH_BROWSER_TIMEOUT_MS = 25_000;

export function authOperation(path: string, search: string) {
  if (path === "token") {
    return new URLSearchParams(search).get("grant_type") === "refresh_token"
      ? "refresh"
      : "signin";
  }
  if (path === "user") return "user";
  if (path === "logout") return "logout";
  if (path === ".well-known/jwks.json") return "jwks";
  return "health";
}

/** Keep the SDK's storage/cookie behaviour; relay only its Auth HTTP requests. */
export function createSupabaseBrowserFetch(
  supabaseUrl: string,
  appOrigin: string,
  fetcher: typeof fetch = (...args) => fetch(...args),
): typeof fetch {
  const upstream = new URL(supabaseUrl);
  const authPrefix = `${upstream.pathname.replace(/\/$/, "")}/auth/v1/`;
  const bounded = createSupabaseFetch(AUTH_BROWSER_TIMEOUT_MS, fetcher);
  const other = createSupabaseFetch(undefined, fetcher);

  return async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      appOrigin,
    );
    if (
      url.origin !== upstream.origin ||
      !url.pathname.startsWith(authPrefix)
    ) {
      return other(input, init);
    }

    const path = url.pathname.slice(authPrefix.length);
    const proxy = new URL(`${AUTH_PROXY_PATH}${path}`, appOrigin);
    proxy.search = url.search;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const requestId = crypto.randomUUID();
    headers.set("X-Samrat-Auth-Request-Id", requestId);
    const started = Date.now();
    try {
      return await bounded(
        input instanceof Request ? new Request(proxy, input) : proxy,
        {
          ...init,
          headers,
          cache: "no-store",
          credentials: "same-origin",
        },
      );
    } catch (error) {
      // Best effort when the browser can still reach our site. Never send the
      // request body, URL query, email, raw exception, password or tokens.
      const name = error instanceof Error ? error.name : "";
      void fetcher(new URL(`${AUTH_PROXY_PATH}diagnostics`, appOrigin), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        keepalive: true,
        body: JSON.stringify({
          requestId,
          operation: authOperation(path, url.search),
          failure:
            name === "TimeoutError" || name === "AbortError"
              ? "timeout"
              : "network",
          durationMs: Date.now() - started,
        }),
      }).catch(() => {});
      throw error;
    }
  };
}
