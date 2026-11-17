import { readSapServiceConnection } from "@/server/sap/config";
import { createHash, randomUUID } from "node:crypto";
import {
  ApiError,
  dbCheck,
  jsonBody,
  uuid,
  withUser,
} from "@/server/api/helpers";
import { grpoEntry, withGrpoPdfs } from "@/server/sap/grpo-pdf";
import { sapFieldConfig } from "@/server/sap/match-data";
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

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withUser(request, async (db, user) => {
    const entry = grpoEntry((await context.params).id);
    const body = await jsonBody(request);
    const caseId = uuid(body?.caseId);
    const { company } = readSapServiceConnection();
    const prior = (
      await grpoUploadStates(db, user, company, [{ docEntry: String(entry) }])
    )[String(entry)];
    if (!prior || prior.caseId !== caseId)
      throw new ApiError(
        "The uploaded case has changed. Refresh before deleting.",
        409,
      );
    if (prior.deleted) return { caseId, deleted: true };
    if (prior.sapDraft?.status !== "not_created")
      throw new ApiError(
        "Only cases confirmed as not drafted can be deleted here. Refresh the draft status.",
        409,
      );
    if (prior.status === "processing")
      throw new ApiError(
        "Wait for analysis to finish before deleting this case.",
        409,
      );
    const recycled = await db.rpc("decide_case", {
      p_user: user,
      p_case: caseId,
      p_action: "recycle",
    });
    dbCheck(recycled.error);
    if (!recycled.data?.deleted_at)
      throw new ApiError(
        "The case could not be confirmed in Recycle Bin. Refresh and check before retrying.",
        503,
      );
    return { caseId, deleted: true };
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withUser(request, async (db, user) => {
    const entry = grpoEntry((await context.params).id);
    const body = await jsonBody(request);
    if (!["prepare", "file", "finish"].includes(body.action))
      throw new ApiError("Invalid import step.");
    const { company } = readSapServiceConnection();
    const prior = (
      await grpoUploadStates(db, user, company, [{ docEntry: String(entry) }])
    )[String(entry)];
    if (prior && !prior.deleted) return { existing: true, ...prior };
    const rejectExistingDraft =
      body.action === "file"
        ? undefined
        : { invoiceRefField: sapFieldConfig().invoiceRefField };
    return withGrpoPdfs(
      entry,
      async (source) => {
        const manifest = createHash("sha256")
          .update(
            JSON.stringify([
              source.environment,
              source.company,
              source.docNum,
              source.files,
            ]),
          )
          .digest("hex");
        const preparing = body.action === "prepare";
        const completeSinglePdf =
          preparing &&
          body.completeSinglePdf === true &&
          source.files.length === 1;
        if (preparing && !completeSinglePdf)
          return {
            files: source.files.map((f) => ({ name: f.name, index: f.index })),
            day: new Date().toISOString().slice(0, 10),
            manifest,
            session: randomUUID(),
          };
        if (!preparing && body.manifest !== manifest)
          throw new ApiError(
            "SAP attachments changed. Refresh and retry.",
            409,
          );
        const day = preparing
          ? new Date().toISOString().slice(0, 10)
          : importDay(body.day);
        const session = preparing ? randomUUID() : uuid(body.session);
        const assetId = (index: number) =>
          importAssetId(
            user,
            source.company,
            entry,
            day,
            index,
            source.environment === "live" || completeSinglePdf
              ? `${source.environment}:${manifest}:${prior?.deleted ? prior.caseId : ""}`
              : session,
          );
        if (body.action === "file" || completeSinglePdf) {
          const index = completeSinglePdf ? 0 : body.index;
          if (!Number.isInteger(index) || !source.files[index])
            throw new ApiError("Invalid PDF selection.");
          const file = source.files[index];
          const name = `${file.index + 1}-${file.name.slice(0, -4).slice(0, 230)}.pdf`;
          const stored = await storeGrpoPdf(db, user, {
            id: assetId(file.index),
            name,
            bytes: await source.download(file.index),
          });
          if (!completeSinglePdf) return stored;
        }
        return attachGrpoPdfs(
          db,
          user,
          source.files.map((f) => assetId(f.index)),
          {
            environment: source.environment,
            company: source.company,
            docEntry: entry,
            docNum: source.docNum,
          },
        );
      },
      { rejectExistingDraft },
    );
  });
}
