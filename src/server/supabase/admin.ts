import { createClient } from "@supabase/supabase-js";
import { getSupabaseServerUrl } from "@/lib/supabase/config";
import { createSupabaseFetch } from "@/lib/supabase/fetch";

function requireEnv(name: string, value?: string) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function createSupabaseAdminClient(options?: {
  fetchTimeoutMs: number;
}) {
  const supabaseUrl = requireEnv("Supabase server URL", getSupabaseServerUrl());
  const serviceRoleKey = requireEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  return createClient(supabaseUrl, serviceRoleKey, {
    ...(options
      ? { global: { fetch: createSupabaseFetch(options.fetchTimeoutMs) } }
      : {}),
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
