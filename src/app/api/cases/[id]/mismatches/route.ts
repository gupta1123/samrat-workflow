import {
  ApiError,
  dbCheck,
  jsonBody,
  uuid,
  withUser,
} from "@/server/api/helpers";
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    const body = await jsonBody(request);
    if (
      !["accept", "reject"].includes(body.action) ||
      !Array.isArray(body.mismatchIds) ||
      !body.mismatchIds.length ||
      body.mismatchIds.length > 500
    )
      throw new ApiError("Select valid issues and a review decision.");
    const { data, error } = await db.rpc("resolve_mismatches", {
      p_user: user,
      p_case: uuid(id),
      p_ids: body.mismatchIds.map(uuid),
      p_decision: body.action === "accept" ? "accepted" : "rejected",
    });
    dbCheck(error);
    return data;
  });
}
