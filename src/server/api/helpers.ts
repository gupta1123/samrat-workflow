import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "../supabase/admin";
import { requireRequestUser } from "./request-auth";
export class ApiError extends Error {
  constructor(
    message: string,
    public status = 400,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new ApiError("Invalid identifier.");
  return value;
}
export async function jsonBody(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > 256 * 1024)
    throw new ApiError("Request is too large.", 413);
  try {
    return await request.json();
  } catch {
    throw new ApiError("Invalid JSON request.");
  }
}
export function dbCheck(error: { message: string; code?: string } | null) {
  if (error) {
    if (error.code === "P0001") throw new ApiError(error.message, 409);
    throw error;
  }
}
export async function withUser(
  request: Request,
  fn: (
    db: ReturnType<typeof createSupabaseAdminClient>,
    userId: string,
  ) => Promise<unknown>,
) {
  try {
    const user = await requireRequestUser(request);
    if (!user)
      throw new ApiError("Your session has expired. Sign in again.", 401);
    const result = await fn(createSupabaseAdminClient(), user.id);
    if (result instanceof Response) return result;
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof ApiError)
      return NextResponse.json(
        { error: error.message, ...error.extra },
        { status: error.status },
      );
    console.error(
      "API request failed",
      error instanceof Error
        ? error.message
        : (error as { code?: string })?.code,
    );
    return NextResponse.json(
      {
        error:
          "The request could not be completed. Check your Supabase setup or retry.",
      },
      { status: 500 },
    );
  }
}
export function mapCase(row: {
  id: string;
  slug: string;
  display_name: string;
  buyer_name: string | null;
  po_number: string | null;
  invoice_number: string | null;
  status: string;
  risk_score: number;
  upload_count: number;
  document_count: number;
  mismatch_count: number;
  created_at: string;
  deleted_at: string | null;
  processing_meta: {
    receiverName?: string;
    caseCategory?: string;
    [key: string]: unknown;
  };
}) {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    buyerName: row.buyer_name,
    receiverName: row.processing_meta?.receiverName ?? row.buyer_name,
    category: row.processing_meta?.caseCategory || "Document packet",
    poNumber: row.po_number,
    invoiceNumber: row.invoice_number,
    status: row.status,
    riskScore: row.risk_score,
    uploadCount: row.upload_count,
    documentCount: row.document_count,
    mismatchCount: row.mismatch_count,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    processingMeta: row.processing_meta,
  };
}
export async function ownedCase(
  db: ReturnType<typeof createSupabaseAdminClient>,
  userId: string,
  caseId: string,
  includeDeleted = false,
) {
  const { data, error } = await db
    .from("packet_cases")
    .select("*")
    .eq("id", uuid(caseId))
    .eq("owner_user_id", userId)
    .maybeSingle();
  dbCheck(error);
  if (!data || (!includeDeleted && data.deleted_at))
    throw new ApiError("Case not found.", 404);
  return data;
}
