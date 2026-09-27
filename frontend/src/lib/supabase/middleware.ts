import { createServerClient } from "@supabase/ssr";
import {
  isAuthApiError,
  isAuthSessionMissingError,
} from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseFetch } from "./fetch";
import {
  getSupabasePublishableKey,
  getSupabaseServerUrl,
  SUPABASE_AUTH_COOKIE_NAME,
} from "./config";

function requireEnv(name: string, value?: string) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const INVALID_SESSION_ERROR_CODES = new Set([
  "bad_jwt",
  "invalid_credentials",
  "no_authorization",
  "refresh_token_already_used",
  "refresh_token_not_found",
  "session_expired",
  "session_not_found",
  "unexpected_audience",
  "user_not_found",
]);

function isInvalidSessionError(error: unknown) {
  if (isAuthSessionMissingError(error)) {
    return true;
  }

  if (
    error instanceof Error &&
    (error.name === "AuthInvalidJwtError" ||
      error.name === "AuthInvalidTokenResponseError")
  ) {
    return true;
  }

  return (
    isAuthApiError(error) &&
    (error.status === 401 ||
      Boolean(error.code && INVALID_SESSION_ERROR_CODES.has(error.code)))
  );
}

function redirectToLogin(
  request: NextRequest,
  pathname: string,
  options: { clearSession?: boolean; supabaseUrl?: string } = {},
) {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  if (pathname !== "/") {
    url.searchParams.set("next", pathname);
  }

  const redirect = NextResponse.redirect(url);

  if (options.clearSession && options.supabaseUrl) {
    request.cookies.getAll().forEach(({ name }) => {
      if (name.startsWith(SUPABASE_AUTH_COOKIE_NAME)) {
        redirect.cookies.set(name, "", {
          maxAge: 0,
          path: "/",
        });
      }
    });
  }

  return redirect;
}

export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const supabaseUrl = getSupabaseServerUrl();
  const publishableKey = getSupabasePublishableKey();
  const configured = Boolean(supabaseUrl && publishableKey);
  if (pathname === "/setup") return NextResponse.next({ request });
  if (!configured) return NextResponse.redirect(new URL("/setup", request.url));
  const isAuthRoute =
    pathname.startsWith("/login") || pathname.startsWith("/auth");

  if (isAuthRoute) {
    return NextResponse.next({
      request,
    });
  }

  let response = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    requireEnv("Supabase server URL", supabaseUrl),
    requireEnv("Supabase publishable key", publishableKey),
    {
      cookieOptions: { name: SUPABASE_AUTH_COOKIE_NAME },
      global: {
        fetch: createSupabaseFetch(),
      },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  let userId: string | null = null;

  try {
    const result = await supabase.auth.getClaims();
    if (result.error) {
      if (isAuthSessionMissingError(result.error)) {
        userId = null;
      } else if (isInvalidSessionError(result.error)) {
        console.warn("Discarding an invalid Supabase browser session", {
          code: result.error.code,
          status: result.error.status,
        });
        return redirectToLogin(request, pathname, {
          clearSession: true,
          supabaseUrl,
        });
      } else {
        throw result.error;
      }
    } else {
      const subject = result.data?.claims.sub;
      userId =
        typeof subject === "string" &&
        subject.length > 0 &&
        result.data?.claims.is_anonymous !== true
          ? subject
          : null;
    }
  } catch (error) {
    console.error("Supabase auth service could not be reached:", error);

    return new NextResponse(
      "The authentication service is temporarily unreachable. Please refresh in a moment.",
      {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": "5",
        },
      },
    );
  }

  if (!userId) {
    return redirectToLogin(request, pathname);
  }

  return response;
}
