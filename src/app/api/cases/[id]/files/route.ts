import { NextResponse } from "next/server";
import {
  ApiError,
  dbCheck,
  jsonBody,
  mapCase,
  ownedCase,
  uuid,
  withUser,
} from "@/server/api/helpers";
import {
  inlineCaseFileResponse,
  listDraftCaseFiles,
} from "@/server/case-files";
import { mapProcessingJob } from "@/server/processing/jobs";
import { verifyUploads } from "@/server/uploads";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    await ownedCase(db, user, id);
    const search = new URL(request.url).searchParams;
    const fileId = search.get("fileId");
    if (!fileId || search.get("content") !== "1") {
      throw new ApiError("File not found.", 404);
    }
    const fileResult = await db
      .from("packet_case_files")
      .select("id, original_name, storage_bucket, storage_path, mime_type")
      .eq("id", uuid(fileId))
      .eq("case_id", uuid(id))
      .maybeSingle();
    dbCheck(fileResult.error);
    if (!fileResult.data) throw new ApiError("File not found.", 404);
    const file = fileResult.data;
    const bucket = file.storage_bucket || "packet-files";
    if (search.get("content") !== "1") {
      const signed = await db.storage
        .from(bucket)
        .createSignedUrl(file.storage_path, 300);
      dbCheck(signed.error);
      if (!signed.data?.signedUrl) {
        throw new ApiError("File content is unavailable.", 404);
      }
      return { fileId: file.id, signedUrl: signed.data.signedUrl };
    }
    const download = await db.storage.from(bucket).download(file.storage_path);
    if (download.error || !download.data) {
      throw new ApiError("File content is unavailable.", 404);
    }
    return inlineCaseFileResponse(download.data, {
      originalName: file.original_name,
      mimeType: file.mime_type,
    });
  });
}

export async function POST(request: Request, context: Context) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    await ownedCase(db, user, id);
    const body = await jsonBody(request);
    const ids = await verifyUploads(db, user, body.uploadIds);
    const { data, error } = await db.rpc("attach_case_uploads", {
      p_user: user,
      p_upload_ids: ids,
      p_case_id: uuid(id),
      p_mode: body.mode === "overwrite" ? "overwrite" : "append",
      p_allow_duplicate: body.allowDuplicate === true,
    });
    dbCheck(error);
    if (data.duplicateCase)
      throw new ApiError("These documents already belong to a saved case.", 409, {
        duplicateCase: data.duplicateCase,
      });
    return {
      case: mapCase(data.case),
      files: await listDraftCaseFiles(db, data.case.id),
    };
  });
}

export async function PATCH(request: Request, context: Context) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    const body = await jsonBody(request);
    if (typeof body.fileId !== "string" || !body.fileId.trim()) {
      throw new ApiError("Choose the file to replace.");
    }
    const ids = await verifyUploads(db, user, body.uploadIds);
    if (!ids.length) throw new ApiError("Choose a replacement document.");
    const { data, error } = await db.rpc("edit_draft_case_file", {
      p_user: user,
      p_case: uuid(id),
      p_file: uuid(body.fileId),
      p_action: "replace",
      p_upload: ids[0],
    });
    dbCheck(error);
    return {
      case: mapCase(data.case),
      files: await listDraftCaseFiles(db, data.case.id),
    };
  });
}

export async function DELETE(request: Request, context: Context) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    const search = new URL(request.url).searchParams;
    const body = await request
      .clone()
      .json()
      .catch(() => ({}));
    const rawFileId =
      search.get("fileId") ??
      (typeof body.fileId === "string" ? body.fileId : null);
    if (!rawFileId || !rawFileId.trim()) {
      throw new ApiError("Choose the file to remove.");
    }
    const fileUuid = uuid(rawFileId.trim());

    const row = await ownedCase(db, user, id);

    // Draft cases keep the original transactional remove path.
    if (row.status === "draft") {
      const { data, error } = await db.rpc("edit_draft_case_file", {
        p_user: user,
        p_case: uuid(id),
        p_file: fileUuid,
        p_action: "remove",
      });
      dbCheck(error);
      return {
        case: mapCase(data.case),
        files: await listDraftCaseFiles(db, data.case.id),
      };
    }

    // Analyzed cases: remove one file and re-analyze the remainder
    // automatically. Used to delete a duplicate upload straight from the
    // duplicate-invoice warning: once the extra copy is gone, the duplicate
    // issue cannot reappear.
    if (row.status !== "completed" && row.status !== "failed") {
      throw new ApiError(
        "Files can only be removed before analysis starts or after it finishes. Approved or rejected cases are final.",
        409,
      );
    }

    const fileResult = await db
      .from("packet_case_files")
      .select("id, original_name, storage_bucket, storage_path, storage_asset_id")
      .eq("id", fileUuid)
      .eq("case_id", uuid(id))
      .maybeSingle();
    dbCheck(fileResult.error);
    if (!fileResult.data) throw new ApiError("File not found in this case.", 404);

    const remainingResult = await db
      .from("packet_case_files")
      .select("id")
      .eq("case_id", uuid(id))
      .neq("id", fileUuid);
    dbCheck(remainingResult.error);
    if (!remainingResult.data?.length) {
      throw new ApiError(
        "A case needs at least one file. Recycle the case instead of removing its last file.",
        409,
      );
    }

    const file = fileResult.data;
    const bucket = file.storage_bucket || "packet-files";

    // Drop every extracted document that came from this file. Names are
    // unique per case, so the source file name identifies its documents.
    const docsDelete = await db
      .from("packet_documents")
      .delete()
      .eq("case_id", uuid(id))
      .eq("source_file_name", file.original_name);
    dbCheck(docsDelete.error);

    // Mismatches belong to the old document set; analysis regenerates them.
    const mismatchesDelete = await db
      .from("packet_mismatches")
      .delete()
      .eq("case_id", uuid(id));
    dbCheck(mismatchesDelete.error);

    const fileDelete = await db
      .from("packet_case_files")
      .delete()
      .eq("id", fileUuid)
      .eq("case_id", uuid(id));
    dbCheck(fileDelete.error);

    if (file.storage_asset_id) {
      await db.storage.from(bucket).remove([file.storage_path]);
      const assetDelete = await db
        .from("storage_assets")
        .delete()
        .eq("id", file.storage_asset_id)
        .eq("owner_user_id", user);
      dbCheck(assetDelete.error);
    }

    const resetResult = await db
      .from("packet_cases")
      .update({
        status: "draft",
        document_count: 0,
        mismatch_count: 0,
        upload_count: remainingResult.data.length,
      })
      .eq("id", uuid(id))
      .eq("owner_user_id", user)
      .select("*")
      .maybeSingle();
    dbCheck(resetResult.error);
    if (!resetResult.data) throw new ApiError("Case not found.", 404);

    const eventResult = await db.from("case_review_events").insert({
      case_id: id,
      owner_user_id: user,
      action: "case_file_removed",
      details: {
        fileName: file.original_name,
        reason: "duplicate_upload",
      },
    });
    dbCheck(eventResult.error);

    // Re-analyze the remainder immediately so the reviewer lands back on a
    // fresh result instead of an empty draft.
    const enqueued = await db.rpc("enqueue_case_analysis", {
      p_user: user,
      p_case: uuid(id),
      p_options: { analysisMode: "standard" },
    });
    if (enqueued.error) {
      return NextResponse.json(
        {
          case: mapCase(resetResult.data),
          files: await listDraftCaseFiles(db, id),
          warning:
            "File removed, but analysis could not restart automatically. Start it from the case page.",
        },
        { status: 202 },
      );
    }
    return {
      case: mapCase(enqueued.data.case),
      job: mapProcessingJob(enqueued.data.job),
    };
  });
}
