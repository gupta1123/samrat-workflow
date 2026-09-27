// Next.js/hosting adapters can expose an internal URL while preserving the
// browser-facing Host header. Compare the browser Origin with that public host.
export function isSameOriginRequest(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const source = new URL(origin);
    const host = request.headers.get("host") || new URL(request.url).host;
    return (
      ["http:", "https:"].includes(source.protocol) &&
      source.host.toLowerCase() === host.toLowerCase()
    );
  } catch {
    return false;
  }
}
