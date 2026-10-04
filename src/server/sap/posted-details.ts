import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import { postedSapDetails } from "@/lib/sap-posted-details";

type Db = ReturnType<typeof createSupabaseAdminClient>;
export async function readPostedSapDetails(
  db: Db,
  user: string,
  id: string,
  environment: string,
  posting: Parameters<typeof postedSapDetails>[0],
) {
  const [events, candidates] = await Promise.all([
    db
      .from("case_review_events")
      .select("action, created_at")
      .eq("case_id", id)
      .eq("owner_user_id", user)
      .in("action", [
        "sap_ap_draft_created",
        "sap_ap_draft_linked",
        "sap_ap_invoice_posted",
        "sap_ap_invoice_linked",
      ])
      .order("created_at"),
    db
      .from("packet_cases")
      .select("id")
      .eq("owner_user_id", user)
      .neq("id", id)
      .is("deleted_at", null)
      .in("status", ["completed", "accepted", "rejected"])
      .order("created_at"),
  ]);
  // Optional navigation/history reads must not hide the confirmed posting.
  if (events.error) console.error("Could not read SAP posting history");
  if (candidates.error) console.error("Could not read the next SAP case");
  const ids = (candidates.error ? [] : (candidates.data ?? [])).map(
    (row) => row.id,
  );
  let next: string | null = null;
  if (ids.length) {
    const posted = await db
      .from("sap_postings")
      .select("case_id")
      .eq("owner_user_id", user)
      .eq("kind", "AP")
      .eq("sap_env", environment)
      .eq("status", "posted")
      .in("case_id", ids);
    if (posted.error)
      console.error("Could not check the next SAP case posting");
    else {
      const completed = new Set((posted.data ?? []).map((row) => row.case_id));
      next = ids.find((candidate) => !completed.has(candidate)) ?? null;
    }
  }
  return postedSapDetails(
    posting,
    events.error ? [] : (events.data ?? []),
    next,
  );
}
