import "server-only";

import { ProxyAgent, fetch as undiciFetch } from "undici";

let proxyUrl: string | null = null;
let proxyAgent: ProxyAgent | null = null;

function readProxyUrl(): string | null {
  const value = (process.env.QUOTAGUARDSTATIC_URL ?? "").trim();
  return value || null;
}

function dispatcherFor(url: string): ProxyAgent {
  if (!proxyAgent || proxyUrl !== url) {
    proxyAgent?.close().catch(() => undefined);
    proxyUrl = url;
    proxyAgent = new ProxyAgent(url);
  }
  return proxyAgent;
}

/**
 * Send SAP traffic through the configured static-egress proxy. Without the
 * proxy variable, local development continues to use the normal connection.
 */
export function sapFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<globalThis.Response> {
  const url = readProxyUrl();
  if (!url) return fetch(input, init);

  const proxyInit = {
    ...init,
    dispatcher: dispatcherFor(url),
  } as unknown as Parameters<typeof undiciFetch>[1];

  return undiciFetch(input, proxyInit) as unknown as Promise<globalThis.Response>;
}

export function isSapStaticEgressConfigured(): boolean {
  return readProxyUrl() !== null;
}
