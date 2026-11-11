import { createHash } from "node:crypto";
import { ApiError, dbCheck } from "@/server/api/helpers";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import { readSapServiceConnection } from "./config";
import { SapServiceLayerError } from "./service-layer";

type Db = ReturnType<typeof createSupabaseAdminClient>;

/** Serialize the actual SAP write across cases and app users. */
export async function submitProductionDraft<T>(
  db: Db,
  input: { caseId: string; userId: string; vendor: string; invoice: string },
  submit: () => Promise<T>,
) {
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        "sap-ap-draft-v1",
        readSapServiceConnection("live").company.toUpperCase(),
        input.vendor.trim().toUpperCase(),
        input.invoice.trim().toUpperCase(),
      ]),
    )
    .digest("hex");
  const id = `${key.slice(0, 8)}-${key.slice(8, 12)}-5${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`;
  const claim = await db.from("sap_postings").insert({
    id,
    case_id: input.caseId,
    owner_user_id: input.userId,
    kind: "AP",
    status: "blocked",
    sap_env: "live",
    payload: { draftSubmissionPending: true },
  });
  if (claim.error?.code === "23505") {
    throw new ApiError(
      "A draft submission for this case or supplier invoice is already recorded. Check SAP for the draft before retrying.",
      409,
    );
  }
  dbCheck(claim.error);
  try {
    return await submit();
  } catch (error) {
    // An SAP business rejection is definitive. A lost connection or an
    // uncertain response retains the claim, so a retry cannot duplicate it.
    if (
      error instanceof SapServiceLayerError &&
      error.sapDetail &&
      [400, 401, 403, 404, 409, 422].includes(error.status)
    ) {
      const released = await db
        .from("sap_postings")
        .delete()
        .eq("id", id)
        .eq("status", "blocked");
      dbCheck(released.error);
      throw error;
    }
    throw new ApiError(
      "SAP did not confirm the draft result. Check SAP for this supplier invoice before retrying.",
      502,
    );
  }
}
