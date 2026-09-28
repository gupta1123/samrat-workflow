export const SUPABASE_AUTH_COOKIE_NAME = "samrat-auth-token";

function firstValue(...values: Array<string | undefined>) {
  return values.find((value) => Boolean(value?.trim()))?.trim();
}

export function getSupabaseServerUrl() {
  return firstValue(
    process.env.SUPABASE_INTERNAL_URL,
    process.env.SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  );
}

export function getSupabasePublishableKey() {
  return firstValue(
    process.env.SUPABASE_PUBLISHABLE_KEY,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}

function isLoopbackHostname(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("127.")
  );
}

/**
 * Cloud Supabase URLs are already browser-reachable and must be preserved.
 * Local and self-hosted installs deliberately derive the browser hostname from
 * the current request/window so another machine can reach the exposed port.
 */
export function getDirectSupabasePublicUrl() {
  if (firstValue(process.env.SUPABASE_PUBLIC_PORT)) return undefined;

  const configuredUrl = firstValue(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_URL,
  );
  if (!configuredUrl) return undefined;

  try {
    const url = new URL(configuredUrl);
    if (isLoopbackHostname(url.hostname)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function getSupabasePublicPort() {
  const configuredPort = firstValue(process.env.SUPABASE_PUBLIC_PORT);
  if (configuredPort) return configuredPort;

  const configuredUrl = firstValue(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_URL,
  );
  if (configuredUrl) {
    try {
      const url = new URL(configuredUrl);
      if (url.port) return url.port;
      return url.protocol === "https:" ? "443" : "80";
    } catch {
      // The client constructors report malformed Supabase URLs with context.
    }
  }

  return "8000";
}

type SamratRuntimeConfig = {
  supabaseUrl?: string;
  publishableKey?: string;
};

declare global {
  interface Window {
    __SAMRAT_RUNTIME_CONFIG__?: SamratRuntimeConfig;
  }
}

export function getSupabaseBrowserConfig() {
  const runtime =
    typeof window === "undefined" ? undefined : window.__SAMRAT_RUNTIME_CONFIG__;

  return {
    url: firstValue(runtime?.supabaseUrl, process.env.NEXT_PUBLIC_SUPABASE_URL),
    publishableKey: firstValue(
      runtime?.publishableKey,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ),
  };
}

export function publicSupabaseUrlForRequest(request: Request) {
  const directUrl = getDirectSupabasePublicUrl();
  if (directUrl) return new URL(directUrl);

  const requestUrl = new URL(request.url);
  const publicUrl = new URL(requestUrl.origin);
  publicUrl.port = getSupabasePublicPort();
  return publicUrl;
}

export function externalizeSupabaseUrl(value: string, request: Request) {
  const url = new URL(value);
  const publicUrl = publicSupabaseUrlForRequest(request);
  url.protocol = publicUrl.protocol;
  url.hostname = publicUrl.hostname;
  url.port = publicUrl.port;
  return url.toString();
}
