import { handleAuthProxy } from "@/server/auth-proxy";
import {
  getSupabasePublishableKey,
  getSupabaseServerUrl,
} from "@/lib/supabase/config";

export const dynamic = "force-dynamic";

async function relay(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return handleAuthProxy(request, (await context.params).path, {
    url: getSupabaseServerUrl(),
    key: getSupabasePublishableKey(),
    log: (event) => {
      if (event.status >= 400 || event.status === 0)
        console.warn(JSON.stringify(event));
      else console.info(JSON.stringify(event));
    },
  });
}

export { relay as GET, relay as POST };
