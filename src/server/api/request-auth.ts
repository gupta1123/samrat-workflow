import { isSameOriginRequest } from "./origin";
import { createSupabaseServerClient } from "@/server/supabase/server";
import { createClient } from "@supabase/supabase-js";
import {
  getSupabasePublishableKey,
  getSupabaseServerUrl,
} from "@/lib/supabase/config";

function userFromClaims(
  data: { claims: { sub?: string; is_anonymous?: boolean } } | null,
) {
  const subject = data?.claims.sub;
  return typeof subject === "string" &&
    subject.length > 0 &&
    data?.claims.is_anonymous !== true
    ? { id: subject }
    : null;
}

// Verify the signed access token on every request, including bearer-token API
// requests. With asymmetric signing keys, getClaims() verifies locally after
// the project's JWKS is cached instead of making an Auth network round trip.
// There is intentionally no local or production authentication bypass.
export async function requireRequestUser(
  request: Request,
): Promise<{ id: string } | null> {
  if (!isSameOriginRequest(request)) return null;
  const url = getSupabaseServerUrl();
  const key = getSupabasePublishableKey();
  if (!url || !key) return null;
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return null;
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.getClaims(token);
    return error ? null : userFromClaims(data);
  }
  const client = await createSupabaseServerClient();
  const { data, error } = await client.auth.getClaims();
  return error ? null : userFromClaims(data);
}
