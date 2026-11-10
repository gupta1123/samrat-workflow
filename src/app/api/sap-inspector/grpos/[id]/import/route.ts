import { createHash, randomUUID } from "node:crypto";
import { ApiError, jsonBody, uuid, withUser } from "@/server/api/helpers";
import { grpoEntry, withGrpoPdfs } from "@/server/sap/grpo-pdf";
import {
  attachGrpoPdfs,
  grpoUploadStates,
  importAssetId,
  importDay,
  storeGrpoPdf,
} from "@/server/sap/grpo-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withUser(request, async (db, user) => {
    const entry = grpoEntry((await context.params).id);
    const body = await jsonBody(request);
    if (!["prepare", "file", "finish"].includes(body.action))
      throw new ApiError("Invalid import step.");
    const company = process.env.SAP_SL_TEST_COMPANY_DB ?? "";
    const prior = (
      await grpoUploadStates(db, user, company, [{ docEntry: String(entry) }])
    )[String(entry)];
    if (prior) return { existing: true, ...prior };
    return withGrpoPdfs(entry, async (source) => {
      const manifest = createHash("sha256")
        .update(JSON.stringify(source.files))
        .digest("hex");
      if (body.action === "prepare")
        return {
          files: source.files.map((f) => ({ name: f.name, index: f.index })),
          day: new Date().toISOString().slice(0, 10),
          manifest,
          session: randomUUID(),
        };
      if (body.manifest !== manifest)
        throw new ApiError("SAP attachments changed. Refresh and retry.", 409);
      const day = importDay(body.day);
      const session = uuid(body.session);
      const assetId = (index: number) =>
        importAssetId(user, source.company, entry, day, index, session);
      if (body.action === "file") {
        if (!Number.isInteger(body.index) || !source.files[body.index])
          throw new ApiError("Invalid PDF selection.");
        const file = source.files[body.index];
        const name = `${file.index + 1}-${file.name.slice(0, -4).slice(0, 230)}.pdf`;
        return storeGrpoPdf(db, user, {
          id: assetId(file.index),
          name,
          bytes: await source.download(file.index),
        });
      }
      return attachGrpoPdfs(
        db,
        user,
        source.files.map((f) => assetId(f.index)),
        { company: source.company, docEntry: entry, docNum: source.docNum },
      );
    });
  });
}
