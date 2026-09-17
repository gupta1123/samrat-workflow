"use client";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const ACCESS_TOKEN_EXPIRY_SAFETY_MS = 30_000;

let browserClient: ReturnType<typeof createSupabaseBrowserClient> | null = null;
let cachedAccessToken: { token: string; expiresAt: number } | null = null;
let pendingAccessToken: Promise<string | null> | null = null;

function clearCachedAccessToken() {
  cachedAccessToken = null;
  pendingAccessToken = null;
}

function getBrowserClient() {
  if (!browserClient) {
    browserClient = createSupabaseBrowserClient();
    browserClient.auth.onAuthStateChange(clearCachedAccessToken);
  }

  return browserClient;
}

async function readAccessToken() {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now()) {
    return cachedAccessToken.token;
  }

  if (pendingAccessToken) {
    return pendingAccessToken;
  }

  pendingAccessToken = getBrowserClient()
    .auth.getSession()
    .then(({ data: { session } }) => {
      const token = session?.access_token ?? null;
      const expiresAtSeconds = session?.expires_at;

      if (token && typeof expiresAtSeconds === "number") {
        const expiresAt =
          expiresAtSeconds * 1000 - ACCESS_TOKEN_EXPIRY_SAFETY_MS;
        if (expiresAt > Date.now()) {
          cachedAccessToken = { token, expiresAt };
        }
      } else {
        cachedAccessToken = null;
      }

      return token;
    })
    .finally(() => {
      pendingAccessToken = null;
    });

  return pendingAccessToken;
}

async function refreshAccessToken() {
  clearCachedAccessToken();
  const {
    data: { session },
  } = await getBrowserClient().auth.refreshSession();
  const token = session?.access_token ?? null;
  const expiresAtSeconds = session?.expires_at;

  if (token && typeof expiresAtSeconds === "number") {
    const expiresAt = expiresAtSeconds * 1000 - ACCESS_TOKEN_EXPIRY_SAFETY_MS;
    if (expiresAt > Date.now()) {
      cachedAccessToken = { token, expiresAt };
    }
  }

  return token;
}

export function buildApiUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  return normalizedPath;
}

export async function getApiAccessToken() {
  return readAccessToken();
}

export async function apiFetch(path: string, init?: RequestInit) {
  const accessToken = await readAccessToken();
  const apiUrl = buildApiUrl(path);

  async function sendRequest(token: string | null) {
    const headers = new Headers(init?.headers);
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    return fetch(apiUrl, {
      ...init,
      headers,
      credentials: "same-origin",
    });
  }

  const response = await sendRequest(accessToken);
  if (response.status !== 401) {
    return response;
  }

  const refreshedAccessToken = await refreshAccessToken().catch(() => null);
  if (!refreshedAccessToken || refreshedAccessToken === accessToken) {
    return response;
  }

  return sendRequest(refreshedAccessToken);
}
