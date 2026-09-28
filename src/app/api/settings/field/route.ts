import { jsonWithCors, optionsWithCors } from "@/server/api/cors";
import { requireRequestUser } from "@/server/api/request-auth";
import { getFieldSettings } from "@/server/field-settings-service";

export function OPTIONS(request: Request) {
  return optionsWithCors(request);
}

export async function GET(request: Request) {
  try {
    const user = await requireRequestUser(request);
    if (!user) {
      return jsonWithCors(request, { error: "Unauthorized" }, { status: 401 });
    }

    const settings = await getFieldSettings();

    if (!settings) {
      return jsonWithCors(
        request,
        { error: "Failed to load settings" },
        { status: 500 },
      );
    }

    return jsonWithCors(request, {
      fieldSettings: settings.fieldSettings,
      docTypeSettings: settings.docTypeSettings,
    });
  } catch (error) {
    console.error("Error in GET /api/settings/field:", error);
    return jsonWithCors(
      request,
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
