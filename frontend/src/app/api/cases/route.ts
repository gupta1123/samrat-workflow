import {
  ApiError,
  dbCheck,
  jsonBody,
  mapCase,
  withUser,
} from "@/server/api/helpers";
import { verifyUploads } from "@/server/uploads";
import { listDraftCaseFiles } from "@/server/case-files";
export const runtime = "nodejs";
export async function GET(request: Request) {
  return withUser(request, async (db, user) => {
    const search = new URL(request.url).searchParams;
    const positive = (value: string | null, fallback: number, max: number) => {
      const number = Number(value);
      return Number.isFinite(number) && number > 0
        ? Math.min(max, Math.floor(number))
        : fallback;
    };
    const limit = positive(search.get("limit"), 25, 500);
    const page = positive(search.get("page"), 1, 100000);
    let query = db
      .from("packet_cases")
      .select("*", { count: "exact" })
      .eq("owner_user_id", user);
    query =
      search.get("scope") === "deleted"
        ? query.not("deleted_at", "is", null)
        : query.is("deleted_at", null);
    const statuses: Record<string, string[]> = {
      pending: ["draft"],
      in_review: ["processing", "completed"],
      completed: ["accepted"],
      failed: ["failed", "rejected"],
    };
    const status = statuses[search.get("status") || ""];
    if (status) query = query.in("status", status);
    const text = (search.get("q") || "")
      .trim()
      .slice(0, 120)
      .replace(/[,()%"\\]/g, " ");
    if (text)
      query = query.or(
        `display_name.ilike.%${text}%,buyer_name.ilike.%${text}%,invoice_number.ilike.%${text}%,po_number.ilike.%${text}%`,
      );
    const sort = search.get("sort");
    query = query
      .order(sort === "name" ? "display_name" : "created_at", {
        ascending: sort === "oldest" || sort === "name",
      })
      .order("id");
    const { data, error, count } = await query.range(
      (page - 1) * limit,
      page * limit - 1,
    );
    dbCheck(error);
    const caseIds = data!.map((entry) => entry.id);
    const persistedIssueCounts = new Map<string, number>();
    if (caseIds.length > 0) {
      const persistedIssues = await db
        .from("packet_mismatches")
        .select("case_id")
        .in("case_id", caseIds);
      dbCheck(persistedIssues.error);
      for (const issue of persistedIssues.data!) {
        persistedIssueCounts.set(
          issue.case_id,
          (persistedIssueCounts.get(issue.case_id) ?? 0) + 1,
        );
      }
    }
    const totalPages = Math.max(1, Math.ceil((count || 0) / limit));
    return {
      cases: data!.map((entry) => ({
        ...mapCase(entry),
        mismatchCount: persistedIssueCounts.get(entry.id) ?? 0,
      })),
      page,
      pageSize: limit,
      totalCount: count,
      totalPages,
      hasMore: page < totalPages,
      nextCursor: null,
    };
  });
}
export async function POST(request: Request) {
  return withUser(request, async (db, user) => {
    const body = await jsonBody(request);
    const ids = await verifyUploads(db, user, body.uploadIds);
    const { data, error } = await db.rpc("attach_case_uploads", {
      p_user: user,
      p_upload_ids: ids,
      p_case_id: null,
      p_mode: "append",
      p_allow_duplicate: body.allowDuplicate === true,
    });
    dbCheck(error);
    if (data.duplicateCase)
      throw new ApiError(
        "These documents already belong to a saved case.",
        409,
        { duplicateCase: data.duplicateCase },
      );
    return {
      case: mapCase(data.case),
      files: await listDraftCaseFiles(db, data.case.id),
    };
  });
}
