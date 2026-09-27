import {
  getDirectSupabasePublicUrl,
  getSupabasePublicPort,
  getSupabasePublishableKey,
} from "@/lib/supabase/config";

export const dynamic = "force-dynamic";

function javascriptString(value: string) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export async function GET() {
  const publishableKey = getSupabasePublishableKey() ?? "";
  const directUrl = getDirectSupabasePublicUrl();
  const publicPort = getSupabasePublicPort();

  const source = `(() => {
  const url = new URL(window.location.origin);
  url.port = ${javascriptString(publicPort)};
  window.__SAMRAT_RUNTIME_CONFIG__ = {
    supabaseUrl: ${directUrl ? javascriptString(directUrl) : "url.origin"},
    publishableKey: ${javascriptString(publishableKey)}
  };
})();`;

  return new Response(source, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
