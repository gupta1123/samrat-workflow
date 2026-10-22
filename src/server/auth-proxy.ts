import { createSupabaseFetch } from "../lib/supabase/fetch";
import { isSameOriginRequest } from "./api/origin";

const OPERATIONS = [
  "signin",
  "refresh",
  "user",
  "logout",
  "jwks",
  "health",
] as const;
type Operation = (typeof OPERATIONS)[number];
type AuthLog = {
  scope: "auth-proxy" | "auth-browser";
  requestId: string;
  operation: Operation | "diagnostics";
  outcome: string;
  status: number;
  durationMs: number;
};
type Dependencies = {
  url?: string;
  key?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  log?: (event: AuthLog) => void;
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = "X-Samrat-Auth-Request-Id";

class InputError extends Error {}

async function smallJson(request: Request): Promise<Record<string, unknown>> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw new InputError();
  }
  if (Number(request.headers.get("content-length")) > 16_384 || !request.body)
    throw new InputError();
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16_384) {
        await reader.cancel();
        throw new InputError();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new InputError();
    return value;
  } catch {
    throw new InputError();
  } finally {
    reader.releaseLock();
  }
}

function shortString(value: unknown, max: number) {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Fixed-destination Auth relay. Never a general HTTP proxy or an admin client. */
export async function handleAuthProxy(
  request: Request,
  path: string[],
  deps: Dependencies,
) {
  const started = Date.now();
  const suppliedId = request.headers.get(REQUEST_ID) ?? "";
  const requestId = UUID.test(suppliedId) ? suppliedId : crypto.randomUUID();
  let operation: Operation | "diagnostics" = "health";
  const headers = {
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    [REQUEST_ID]: requestId,
    "X-Supabase-Api-Version": "2024-01-01",
  };
  const log = (status: number, outcome: string) =>
    deps.log?.({
      scope: "auth-proxy",
      requestId,
      operation,
      status,
      outcome,
      durationMs: Date.now() - started,
    });
  const errorResponse = (status: number, msg: string, code: string) =>
    Response.json({ msg, code }, { status, headers });

  if (
    !isSameOriginRequest(request) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    return errorResponse(
      403,
      "This sign-in request is not allowed.",
      "origin_rejected",
    );
  }

  const endpoint = path.join("/");
  const query = new URL(request.url).searchParams;
  if (endpoint === "diagnostics" && request.method === "POST") {
    operation = "diagnostics";
    try {
      const data = await smallJson(request);
      if (
        !UUID.test(String(data.requestId)) ||
        !OPERATIONS.includes(data.operation as Operation) ||
        !["network", "timeout"].includes(String(data.failure)) ||
        !Number.isInteger(data.durationMs) ||
        Number(data.durationMs) < 0 ||
        Number(data.durationMs) > 120_000
      ) {
        throw new InputError();
      }
      // Explicit allowlist: discard all extra fields without logging them.
      deps.log?.({
        scope: "auth-browser",
        requestId: String(data.requestId),
        operation: data.operation as Operation,
        outcome: String(data.failure),
        durationMs: Number(data.durationMs),
        status: 0,
      });
      return new Response(null, { status: 204, headers });
    } catch {
      return errorResponse(
        400,
        "Invalid diagnostic request.",
        "invalid_request",
      );
    }
  }

  const grant = query.get("grant_type");
  if (
    endpoint === "token" &&
    request.method === "POST" &&
    (grant === "password" || grant === "refresh_token")
  ) {
    operation = grant === "password" ? "signin" : "refresh";
  } else if (endpoint === "user" && request.method === "GET")
    operation = "user";
  else if (endpoint === "logout" && request.method === "POST")
    operation = "logout";
  else if (endpoint === ".well-known/jwks.json" && request.method === "GET")
    operation = "jwks";
  else if (endpoint === "health" && request.method === "GET")
    operation = "health";
  else
    return errorResponse(
      404,
      "Unsupported authentication request.",
      "unsupported_auth_request",
    );

  if (!deps.url || !deps.key) {
    log(503, "configuration");
    return errorResponse(
      503,
      `Sign-in is temporarily unavailable. Reference: ${requestId}`,
      "auth_service_unavailable",
    );
  }

  try {
    const target = new URL(
      `${deps.url.replace(/\/$/, "")}/auth/v1/${endpoint}`,
    );
    const upstreamHeaders = new Headers({
      apikey: deps.key,
      Authorization: `Bearer ${deps.key}`,
      "X-Client-Info": "samrat-auth-proxy/1",
      "X-Supabase-Api-Version": "2024-01-01",
    });
    let body: string | undefined;
    if (operation === "signin" || operation === "refresh") {
      const data = await smallJson(request);
      let payload: Record<string, unknown>;
      if (operation === "signin") {
        if (!shortString(data.email, 320) || !shortString(data.password, 4096))
          throw new InputError();
        payload = { email: data.email, password: data.password };
        const security = data.gotrue_meta_security as
          { captcha_token?: unknown } | undefined;
        if (security?.captcha_token !== undefined) {
          if (!shortString(security.captcha_token, 4096))
            throw new InputError();
          payload.gotrue_meta_security = {
            captcha_token: security.captcha_token,
          };
        }
      } else {
        if (!shortString(data.refresh_token, 8192)) throw new InputError();
        payload = { refresh_token: data.refresh_token };
      }
      body = JSON.stringify(payload);
      upstreamHeaders.set("Content-Type", "application/json");
      target.searchParams.set("grant_type", grant!);
    } else if (operation === "user" || operation === "logout") {
      const authorization = request.headers.get("authorization");
      if (authorization && /^Bearer [^\s]{1,16384}$/i.test(authorization)) {
        upstreamHeaders.set("Authorization", authorization);
      }
      if (operation === "logout") {
        const scope = query.get("scope") ?? "global";
        if (!["global", "local", "others"].includes(scope))
          throw new InputError();
        target.searchParams.set("scope", scope);
      }
    }

    const response = await createSupabaseFetch(
      deps.timeoutMs ?? 12_000,
      deps.fetcher,
    )(target, {
      method: request.method,
      headers: upstreamHeaders,
      body,
      signal: request.signal,
      cache: "no-store",
      redirect: "error",
    });
    if (response.status === 204) {
      log(204, "success");
      return new Response(null, { status: 204, headers });
    }
    if (response.status >= 500) {
      log(response.status, "upstream_unavailable");
      return errorResponse(
        503,
        `The sign-in service is temporarily unavailable. Please try again. Reference: ${requestId}`,
        "auth_service_unavailable",
      );
    }
    let data: Record<string, unknown>;
    try {
      data = await response.json();
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error();
      if (
        response.ok &&
        (operation === "signin" || operation === "refresh") &&
        (!shortString(data.access_token, 32_768) ||
          !shortString(data.refresh_token, 8192) ||
          !data.user)
      )
        throw new Error();
    } catch {
      log(502, "invalid_upstream_response");
      return errorResponse(
        502,
        `The sign-in response was interrupted. Please try again. Reference: ${requestId}`,
        "auth_response_invalid",
      );
    }
    log(response.status, response.ok ? "success" : "auth_rejected");
    return Response.json(data, { status: response.status, headers });
  } catch (error) {
    if (error instanceof InputError) {
      log(400, "invalid_request");
      return errorResponse(
        400,
        "Enter a valid email and password, then try again.",
        "invalid_request",
      );
    }
    const timedOut =
      error instanceof Error &&
      ["TimeoutError", "AbortError"].includes(error.name);
    log(timedOut ? 504 : 503, timedOut ? "timeout" : "network");
    return errorResponse(
      timedOut ? 504 : 503,
      `The sign-in connection ${timedOut ? "timed out" : "was interrupted"}. Please try again. Reference: ${requestId}`,
      timedOut ? "auth_timeout" : "auth_service_unavailable",
    );
  }
}
