import { dbCheck } from "@/server/api/helpers";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export function caseFileContentUrl(caseId: string, fileId: string) {
  const search = new URLSearchParams({ fileId, content: "1" });
  return `/api/cases/${encodeURIComponent(caseId)}/files?${search.toString()}`;
}

export function inlineCaseFileResponse(
  data: Blob,
  file: { originalName: string; mimeType?: string | null },
) {
  const encodedName = encodeURIComponent(file.originalName || "document.pdf");
  return new Response(data, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": file.mimeType || data.type || "application/octet-stream",
      "Content-Disposition": `inline; filename*=UTF-8''${encodedName}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function listDraftCaseFiles(db: AdminClient, caseId: string) {
  const { data, error } = await db
    .from("packet_case_files")
    .select("id, original_name, mime_type, size_bytes, created_at")
    .eq("case_id", caseId)
    .order("created_at")
    .order("id");
  dbCheck(error);

  return (data ?? []).map((file) => ({
    id: file.id,
    originalName: file.original_name,
    mimeType: file.mime_type,
    sizeBytes: file.size_bytes,
    createdAt: file.created_at,
  }));
}
