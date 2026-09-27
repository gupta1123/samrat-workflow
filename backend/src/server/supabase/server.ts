import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import {
  getSupabasePublishableKey,
  getSupabaseServerUrl,
  SUPABASE_AUTH_COOKIE_NAME,
} from "@/lib/supabase/config";

function requireEnv(name: string, value?: string) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    requireEnv("Supabase server URL", getSupabaseServerUrl()),
    requireEnv("Supabase publishable key", getSupabasePublishableKey()),
    {
      cookieOptions: { name: SUPABASE_AUTH_COOKIE_NAME },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Components cannot always write cookies directly.
          }
        },
      },
    },
  );
}
