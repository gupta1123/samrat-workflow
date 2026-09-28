import { jsonWithCors, optionsWithCors } from "@/server/api/cors";
import { requireRequestUser } from "@/server/api/request-auth";
import { getComparisonGroups } from "@/server/comparison-groups";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const groups = await getComparisonGroups();
    return jsonWithCors(request, { groups });
  } catch (error) {
    console.error("Error in GET /api/settings/comparison-groups:", error);
    return jsonWithCors(
      request,
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
