import { ApiError, jsonBody, withUser } from "@/server/api/helpers";
import { transferDiagnostic } from "@/server/file-transfer";

export async function POST(request: Request) {
  return withUser(request, async () => {
    if (Number(request.headers.get("content-length")) > 2048)
      throw new ApiError("Diagnostic is too large.", 413);
    const body = await jsonBody(request);
    if (JSON.stringify(body).length > 2048)
      throw new ApiError("Diagnostic is too large.", 413);
    console.warn(JSON.stringify(transferDiagnostic(body)));
    return { recorded: true };
  });
}
