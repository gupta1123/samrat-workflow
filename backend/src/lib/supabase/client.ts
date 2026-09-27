import { createBrowserClient } from "@supabase/ssr";

import { createSupabaseFetch } from "./fetch";
import {
  getSupabaseBrowserConfig,
  SUPABASE_AUTH_COOKIE_NAME,
} from "./config";

function requireEnv(name: string, value?: string) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function createSupabaseBrowserClient() {
  const config = getSupabaseBrowserConfig();
  return createBrowserClient(
    requireEnv("Supabase browser URL", config.url),
    requireEnv("Supabase publishable key", config.publishableKey),
    {
      cookieOptions: { name: SUPABASE_AUTH_COOKIE_NAME },
      global: {
        fetch: createSupabaseFetch(),
      },
    },
  );
}
