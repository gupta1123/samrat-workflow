import { ProxyAgent, fetch as undiciFetch, request } from "undici";
import {
  readStaticEgressProxy,
  type StaticEgressProxy,
} from "@/server/static-egress";

let proxyUrl: string | null = null;
let proxyCa: string | null = null;
let proxyAgent: ProxyAgent | null = null;

function dispatcherFor(proxy: StaticEgressProxy): ProxyAgent {
  const url = proxy.url.href;
  if (!proxyAgent || proxyUrl !== url || proxyCa !== proxy.ca) {
    proxyAgent?.close().catch(() => undefined);
    proxyUrl = url;
    proxyCa = proxy.ca;
    proxyAgent = new ProxyAgent({
      uri: url,
      ...(proxy.custom
        ? {
            proxyTls: {
              rejectUnauthorized: true,
              ...(proxy.ca ? { ca: proxy.ca } : {}),
            },
          }
        : {}),
    });
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
  const proxy = readStaticEgressProxy();
  const proxyInit = {
    ...init,
    ...(proxy ? { dispatcher: dispatcherFor(proxy) } : {}),
  } as unknown as Parameters<typeof undiciFetch>[1];

  return undiciFetch(
    input,
    proxyInit,
  ) as unknown as Promise<globalThis.Response>;
}

export function isSapStaticEgressConfigured(): boolean {
  return readStaticEgressProxy() !== null;
}

/** Server-side download: fetch rejects the client's HTTPS port 5061 as a bad port. */
export async function sapAttachmentDownload(
  url: string,
  authorization: string,
) {
  const proxy = readStaticEgressProxy();
  const response = await request(url, {
    method: "GET",
    headers: { Authorization: authorization, Accept: "application/zip" },
    ...(proxy ? { dispatcher: dispatcherFor(proxy) } : {}),
    maxRedirections: 0,
    signal: AbortSignal.timeout(35_000),
    headersTimeout: 35_000,
    bodyTimeout: 35_000,
  });
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined) headers.set(name, String(value));
  }
  if ([204, 205, 304].includes(response.statusCode)) {
    response.body.destroy();
    return new Response(null, { status: response.statusCode, headers });
  }
  // Guard a pending read when a size/error check cancels the response.
  let cancelled = false;
  const iterator = response.body[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await iterator.next();
        if (cancelled) return;
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    async cancel() {
      cancelled = true;
      response.body.destroy();
      await iterator.return?.().catch(() => {});
    },
  });
  return new Response(body, { status: response.statusCode, headers });
}
