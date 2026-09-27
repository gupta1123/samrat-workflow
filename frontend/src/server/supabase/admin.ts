import { createClient } from "@supabase/supabase-js";
import { getSupabaseServerUrl } from "@/lib/supabase/config";

function requireEnv(name: string, value?: string) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function createSupabaseAdminClient() {
  const supabaseUrl = requireEnv(
    "Supabase server URL",
    getSupabaseServerUrl(),
  );
  const serviceRoleKey = requireEnv(
    "SUPABASE_SERVICE_ROLE_KEY",
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
