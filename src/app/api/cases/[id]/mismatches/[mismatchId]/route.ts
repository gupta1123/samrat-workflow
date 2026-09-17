import {
  ApiError,
  dbCheck,
  jsonBody,
  uuid,
  withUser,
} from "@/server/api/helpers";
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; mismatchId: string }> },
) {
  return withUser(request, async (db, user) => {
    const { id, mismatchId } = await context.params;
    const body = await jsonBody(request);
    if (!["accept", "reject"].includes(body.action))
      throw new ApiError("Invalid review decision.");
    const { data, error } = await db.rpc("resolve_mismatches", {
      p_user: user,
      p_case: uuid(id),
      p_ids: [uuid(mismatchId)],
      p_decision: body.action === "accept" ? "accepted" : "rejected",
    });
    dbCheck(error);
    return { caseStatus: data.caseStatus, mismatch: data.mismatches[0] };
  });
}
