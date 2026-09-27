import { ApiError, dbCheck, jsonBody, withUser } from "@/server/api/helpers";
import { sanitizeComparisonGroups } from "@/server/comparison-groups";
import { DOC_TYPE_EXTRACTION_FIELDS } from "@/server/document-schema";
import { invalidateFieldSettings } from "@/server/field-settings-service";
export async function POST(request: Request) {
  return withUser(request, async (db) => {
    const body = await jsonBody(request);
    if (
      !Array.isArray(body.fields) ||
      !Array.isArray(body.docs) ||
      !Array.isArray(body.groups)
    )
      throw new ApiError("Invalid review settings.");
    const definitions = DOC_TYPE_EXTRACTION_FIELDS as Record<
      string,
      readonly string[]
    >;
    for (const row of body.fields)
      if (
        !definitions[row.doc_type]?.includes(row.field_key) ||
        typeof row.enabled !== "boolean"
      )
        throw new ApiError("Unknown document field.");
    for (const row of body.docs)
      if (!definitions[row.doc_type] || typeof row.enabled !== "boolean")
        throw new ApiError("Unknown document type.");
    const { error } = await db.rpc("save_review_settings", {
      p_fields: body.fields,
      p_docs: body.docs,
      p_groups: sanitizeComparisonGroups(body.groups),
    });
    dbCheck(error);
    invalidateFieldSettings();
    return { success: true };
  });
}
