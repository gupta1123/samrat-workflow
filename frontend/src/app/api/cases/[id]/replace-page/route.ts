import { createHash, randomUUID } from "node:crypto";

import {
  DEFAULT_COMPARISON_OPTIONS,
  readComparisonOptions,
} from "@/server/comparison";
import {
  buildReplacedPacketFile,
  resolveDocumentPageReplacementTarget,
  reviewDocumentPageReplacement,
  toCurrentCaseDocument,
} from "@/server/document-page-replacement";
import {
  ApiError,
  dbCheck,
  jsonBody,
  mapCase,
  ownedCase,
  uuid,
  withUser,
} from "@/server/api/helpers";
import { mapProcessingJob } from "@/server/processing/jobs";
import { renderUploadedFileForReview } from "@/server/processing/pipeline";
import { verifyUploads } from "@/server/uploads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

type StoredAsset = {
  id: string;
  storage_bucket: string;
  storage_path: string;
  original_name: string;
  content_sha256: string;
  mime_type: string;
  size_bytes: number;
  page_count: number | null;
};

type StoredCaseFile = {
  id: string;
  storage_asset_id: string;
  storage_bucket: string;
  storage_path: string;
  original_name: string;
  content_sha256: string;
  mime_type: string | null;
  size_bytes: number | null;
};

function workerUrl(request: Request) {
  const base =
    process.env.APP_BASE_URL ||
    process.env.URL ||
    (process.env.NODE_ENV !== "production" ? new URL(request.url).origin : "");
  if (!base) throw new ApiError("APP_BASE_URL is not configured.", 500);
  return new URL(
    "/.netlify/functions/process-case-background",
    base,
  ).toString();
}

async function downloadVerifiedAsset(
  db: Parameters<Parameters<typeof withUser>[1]>[0],
  asset: Pick<
    StoredAsset,
    "storage_bucket" | "storage_path" | "content_sha256" | "original_name"
  >,
) {
  const download = await db.storage
    .from(asset.storage_bucket || "packet-files")
    .download(asset.storage_path);
  if (download.error || !download.data) {
    throw new ApiError(
      `Could not read ${asset.original_name}. Try again.`,
      422,
    );
  }
  const bytes = new Uint8Array(await download.data.arrayBuffer());
  if (
    createHash("sha256").update(bytes).digest("hex") !== asset.content_sha256
  ) {
    throw new ApiError(
      `The stored contents of ${asset.original_name} did not pass verification. Upload it again.`,
      422,
    );
  }
  return bytes;
}

export async function POST(request: Request, context: Context) {
  return withUser(request, async (db, user) => {
    const workerSecret = process.env.WORKER_SECRET;
    if (process.env.LOCAL_CASE_WORKER !== "true" && !workerSecret) {
      throw new ApiError("WORKER_SECRET is not configured.", 500);
    }
    const { id } = await context.params;
    const caseRow = await ownedCase(db, user, id);
    if (caseRow.status === "processing") {
      throw new ApiError(
        "Wait for the current analysis to finish before replacing a page.",
        409,
      );
    }
    if (caseRow.status === "accepted" || caseRow.status === "rejected") {
      throw new ApiError("A finalized case cannot be changed.", 409);
    }

    const body = await jsonBody(request);
    const mismatchId = uuid(body.mismatchId);
    const uploadIds = await verifyUploads(db, user, body.uploadIds);
    if (uploadIds.length !== 1) {
      throw new ApiError(
        "Choose one image or one-page PDF as the replacement.",
      );
    }

    const [mismatchResult, candidateResult, documentResult] = await Promise.all(
      [
        db
          .from("packet_mismatches")
          .select("id, field_name, values_json")
          .eq("id", mismatchId)
          .eq("case_id", id)
          .maybeSingle(),
        db
          .from("storage_assets")
          .select("*")
          .eq("id", uploadIds[0])
          .eq("owner_user_id", user)
          .maybeSingle(),
        db
          .from("packet_documents")
          .select(
            "id, client_document_id, source_file_name, source_hint, document_type, title, page_count, extracted_fields, markdown",
          )
          .eq("case_id", id)
          .order("created_at"),
      ],
    );
    dbCheck(mismatchResult.error);
    dbCheck(candidateResult.error);
    dbCheck(documentResult.error);
    if (!mismatchResult.data) {
      throw new ApiError(
        "The document-reading warning is no longer active. Refresh the case.",
        409,
      );
    }
    if (!candidateResult.data) {
      throw new ApiError("The staged replacement was not found.", 404);
    }
    const candidate = candidateResult.data as StoredAsset;
    if (candidate.page_count !== 1) {
      throw new ApiError(
        "Choose one image or one-page PDF as the replacement.",
      );
    }

    let target;
    try {
      target = resolveDocumentPageReplacementTarget({
        processingMeta: caseRow.processing_meta,
        mismatch: mismatchResult.data,
      });
    } catch (error) {
      throw new ApiError(
        error instanceof Error
          ? error.message
          : "The exact affected page could not be identified safely.",
        409,
      );
    }

    const fileResult = await db
      .from("packet_case_files")
      .select("*")
      .eq("case_id", id)
      .eq("original_name", target.sourceFileName)
      .maybeSingle();
    dbCheck(fileResult.error);
    if (!fileResult.data) {
      throw new ApiError(
        "The source file for this warning has changed. Refresh the case.",
        409,
      );
    }
    const sourceFile = fileResult.data as StoredCaseFile;

    const [originalBytes, candidateBytes] = await Promise.all([
      downloadVerifiedAsset(db, {
        storage_bucket: sourceFile.storage_bucket,
        storage_path: sourceFile.storage_path,
        content_sha256: sourceFile.content_sha256,
        original_name: sourceFile.original_name,
      }),
      downloadVerifiedAsset(db, candidate),
    ]);

    let originalImages: string[];
    let candidateImages: string[];
    try {
      [originalImages, candidateImages] = await Promise.all([
        renderUploadedFileForReview({
          bytes: originalBytes,
          fileName: sourceFile.original_name,
          mimeType: sourceFile.mime_type,
        }),
        renderUploadedFileForReview({
          bytes: candidateBytes,
          fileName: candidate.original_name,
          mimeType: candidate.mime_type,
        }),
      ]);
    } catch (error) {
      console.warn(
        "Page replacement rendering failed",
        error instanceof Error ? error.message : error,
      );
      throw new ApiError(
        "We could not reliably read the proposed replacement. Use a clear image or one-page PDF.",
        422,
      );
    }
    const originalPageImage = originalImages[target.pageNumber - 1];
    const replacementPageImage = candidateImages[0];
    if (
      !originalPageImage ||
      !replacementPageImage ||
      candidateImages.length !== 1
    ) {
      throw new ApiError(
        "Choose one image or one-page PDF as the replacement.",
        422,
      );
    }

    let decision;
    try {
      decision = await reviewDocumentPageReplacement({
        target,
        currentDocuments: (documentResult.data ?? []).map((row) =>
          toCurrentCaseDocument(row as Record<string, unknown>),
        ),
        originalPageImage,
        replacementPageImage,
      });
    } catch (error) {
      console.warn(
        "Page replacement AI review failed",
        error instanceof Error ? error.message : error,
      );
      throw new ApiError(
        "The reviewer could not verify this page, so the case was not changed. Please retry.",
        503,
      );
    }

    if (decision.decision !== "accepted") {
      const event = await db.from("case_review_events").insert({
        case_id: id,
        owner_user_id: user,
        action: "document_page_replacement_rejected",
        details: {
          mismatchId,
          target,
          candidateAssetId: candidate.id,
          review: decision,
        },
      });
      dbCheck(event.error);
      return { decision: decision.decision, reason: decision.reason, target };
    }

    let replacementFile;
    try {
      replacementFile = await buildReplacedPacketFile({
        originalBytes,
        originalName: sourceFile.original_name,
        originalMimeType: sourceFile.mime_type || "application/octet-stream",
        replacementBytes: candidateBytes,
        replacementMimeType: candidate.mime_type,
        pageNumber: target.pageNumber,
      });
    } catch (error) {
      throw new ApiError(
        error instanceof Error
          ? error.message
          : "The replacement page could not be inserted into the stored file.",
        422,
      );
    }
    if (replacementFile.bytes.byteLength > 50 * 1024 * 1024) {
      throw new ApiError(
        "The rebuilt file is larger than 50 MB. Use a smaller replacement image.",
      );
    }

    const replacementAssetId = randomUUID();
    const replacementPath = `${user}/${replacementAssetId}/${replacementFile.fileName}`;
    const replacementSha = createHash("sha256")
      .update(replacementFile.bytes)
      .digest("hex");
    const reserve = await db.rpc("reserve_upload", {
      p_id: replacementAssetId,
      p_user: user,
      p_path: replacementPath,
      p_name: replacementFile.fileName,
      p_size: replacementFile.bytes.byteLength,
      p_sha: replacementSha,
      p_mime: replacementFile.mimeType,
    });
    dbCheck(reserve.error);

    const stored = await db.storage
      .from("packet-files")
      .upload(replacementPath, replacementFile.bytes, {
        contentType: replacementFile.mimeType,
        upsert: false,
      });
    if (stored.error) {
      throw new ApiError(
        "The verified page could not be saved. The case is unchanged; retry the replacement.",
        503,
      );
    }
    const pageCount = await db
      .from("storage_assets")
      .update({ page_count: replacementFile.pageCount })
      .eq("id", replacementAssetId)
      .eq("owner_user_id", user);
    dbCheck(pageCount.error);

    const processingMeta =
      caseRow.processing_meta && typeof caseRow.processing_meta === "object"
        ? (caseRow.processing_meta as Record<string, unknown>)
        : {};
    const analysisMode =
      processingMeta.analysisMode === "smart_split"
        ? "smart_split"
        : "standard";
    const comparisonOptions = readComparisonOptions(
      processingMeta.comparisonOptions ?? DEFAULT_COMPARISON_OPTIONS,
    );
    const committed = await db.rpc("commit_verified_page_replacement", {
      p_user: user,
      p_case: uuid(id),
      p_case_file: sourceFile.id,
      p_expected_asset: sourceFile.storage_asset_id,
      p_candidate_asset: candidate.id,
      p_replacement_asset: replacementAssetId,
      p_mismatch: mismatchId,
      p_page_number: target.pageNumber,
      p_review: decision,
      p_options: { analysisMode, comparisonOptions },
    });
    dbCheck(committed.error);

    if (process.env.LOCAL_CASE_WORKER !== "true") {
      const targetUrl = workerUrl(request);
      const dispatched = await fetch(targetUrl, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          "X-Worker-Secret": workerSecret!,
        },
        body: JSON.stringify({ jobId: committed.data.job.id }),
      }).catch(() => null);
      if (!dispatched?.ok) {
        console.warn(
          "Replacement saved and queued; background dispatch will retry",
          committed.data.job.id,
          dispatched?.status,
        );
      }
    }

    return {
      decision: "accepted",
      reason: decision.reason,
      target,
      revisionId: committed.data.revisionId,
      case: mapCase(committed.data.case),
      job: mapProcessingJob(committed.data.job),
    };
  });
}
