import {
  readSapEnvironment,
  sapCaseEnvironment,
  sapCaseOrigin,
} from "@/server/sap/config";
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
const CASE_LIST_COLUMNS =
  "id,slug,display_name,buyer_name,po_number,invoice_number,status,risk_score,upload_count,document_count,mismatch_count,created_at,deleted_at,review_flow,supply_kind,receiverName:processing_meta->>receiverName,caseCategory:processing_meta->>caseCategory";
type CaseListRow = Parameters<typeof mapCase>[0] & {
  receiverName?: string;
  caseCategory?: string;
};

export async function GET(request: Request) {
  return withUser(request, async (db, user) => {
    const search = new URL(request.url).searchParams;
    const summaryOnly = search.get("view") === "summary";
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
      .select(summaryOnly ? CASE_LIST_COLUMNS : "*", { count: "exact" })
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
    const { data, error, count } = await query
      .range((page - 1) * limit, page * limit - 1)
      .overrideTypes<CaseListRow[], { merge: false }>();
    dbCheck(error);
    const rows = data ?? [];
    const caseIds = rows.map((entry) => entry.id);
    // Older cases sometimes need source evidence to recover display names or
    // invoice references. Only fetch that evidence for rows that can use it.
    const fallbackIds = summaryOnly
      ? rows
          .filter((row) => {
            const name = row.display_name?.trim();
            return (
              !name ||
              name === "Case" ||
              name === "New case" ||
              (!row.invoice_number && !row.po_number)
            );
          })
          .map((row) => row.id)
      : [];
    const [persistedIssues, identityEvidence] = await Promise.all([
      caseIds.length
        ? db.from("packet_mismatches").select("case_id").in("case_id", caseIds)
        : { data: [], error: null },
      fallbackIds.length
        ? db
            .from("packet_cases")
            .select(
              "id,documentAudits:processing_meta->extractionReview->documentAudits,verificationGroups:processing_meta->verificationGroups",
            )
            .eq("owner_user_id", user)
            .in("id", fallbackIds)
        : { data: [], error: null },
    ]);
    dbCheck(persistedIssues.error);
    dbCheck(identityEvidence.error);
    const persistedIssueCounts = new Map<string, number>();
    for (const issue of persistedIssues.data ?? []) {
      persistedIssueCounts.set(
        issue.case_id,
        (persistedIssueCounts.get(issue.case_id) ?? 0) + 1,
      );
    }
    const identityByCase = new Map(
      (identityEvidence.data ?? []).map((row) => [row.id, row]),
    );
    const totalPages = Math.max(1, Math.ceil((count || 0) / limit));
    return {
      cases: rows.map((entry) => {
        const identity = identityByCase.get(entry.id);
        const result = mapCase(
          summaryOnly
            ? {
                ...entry,
                processing_meta: {
                  receiverName: entry.receiverName,
                  caseCategory: entry.caseCategory,
                  extractionReview: {
                    documentAudits: identity?.documentAudits,
                  },
                  verificationGroups: identity?.verificationGroups,
                },
              }
            : entry,
        );
        return {
          ...result,
          ...(summaryOnly
            ? {
                processingMeta: {
                  receiverName: result.receiverName,
                  caseCategory: result.category,
                },
              }
            : {}),
          mismatchCount: persistedIssueCounts.get(entry.id) ?? 0,
        };
      }),
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
    const attach = (allowDuplicate: boolean) =>
      db.rpc("attach_case_uploads", {
        p_user: user,
        p_upload_ids: ids,
        p_case_id: null,
        p_mode: "append",
        p_allow_duplicate: allowDuplicate,
      });
    let result = await attach(body.allowDuplicate === true);
    dbCheck(result.error);
    let duplicate = result.data.duplicateCase;
    if (duplicate && readSapEnvironment() === "live") {
      const historic = await db
        .from("packet_cases")
        .select("created_at,processing_meta,upload_fingerprint")
        .eq("id", duplicate.id)
        .eq("owner_user_id", user)
        .single();
      dbCheck(historic.error);
      if (!historic.data)
        throw new ApiError("The existing case changed. Retry the upload.", 409);
      if (
        sapCaseEnvironment(
          sapCaseOrigin(
            historic.data.created_at,
            historic.data.processing_meta,
          ),
        ) === "test"
      ) {
        const sameFiles = await db
          .from("packet_cases")
          .select("id,display_name,status,created_at,processing_meta")
          .eq("owner_user_id", user)
          .eq("upload_fingerprint", historic.data.upload_fingerprint)
          .is("deleted_at", null)
          .gte("created_at", process.env.SAP_LIVE_CASES_FROM!)
          .order("created_at");
        dbCheck(sameFiles.error);
        const current = sameFiles.data?.find(
          (row) =>
            sapCaseEnvironment(
              sapCaseOrigin(row.created_at, row.processing_meta),
            ) === "live",
        );
        if (current) {
          duplicate = {
            id: current.id,
            displayName: current.display_name,
            status: current.status,
            createdAt: current.created_at,
          };
        } else {
          result = await attach(true);
          dbCheck(result.error);
          duplicate = result.data.duplicateCase;
        }
      }
    }
    if (duplicate)
      throw new ApiError(
        "These documents already belong to a saved case.",
        409,
        { duplicateCase: duplicate },
      );
    const { data } = result;
    return {
      case: mapCase(data.case),
      files: await listDraftCaseFiles(db, data.case.id),
    };
  });
}
