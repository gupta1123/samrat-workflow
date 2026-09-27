import { createHash } from "node:crypto";

import { readMissingDocumentGroups } from "@/lib/missing-documents";
import {
  ApiError,
  dbCheck,
  jsonBody,
  mapCase,
  ownedCase,
  withUser,
} from "@/server/api/helpers";
import {
  reviewMissingDocumentUploads,
  type MissingDocumentCandidate,
} from "@/server/missing-document-upload";
import { extractUploadedPacketFile } from "@/server/processing/pipeline";
import { ensureCaseFilePageCounts, verifyUploads } from "@/server/uploads";
import type { CaseDoc } from "@/types/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

type StorageAsset = {
  id: string;
  storage_path: string;
  original_name: string;
  content_sha256: string;
  mime_type: string | null;
};

function toCurrentDocument(row: Record<string, unknown>): CaseDoc {
  return {
    id: String(row.client_document_id || row.id),
    type: row.document_type as CaseDoc["type"],
    title: String(row.title || row.document_type || "Document"),
    pages: Math.max(1, Number(row.page_count) || 1),
    fields:
      row.extracted_fields &&
      typeof row.extracted_fields === "object" &&
      !Array.isArray(row.extracted_fields)
        ? (row.extracted_fields as CaseDoc["fields"])
        : {},
    md: typeof row.markdown === "string" ? row.markdown : "",
    sourceFileName:
      typeof row.source_file_name === "string"
        ? row.source_file_name
        : undefined,
    sourceHint:
      typeof row.source_hint === "string" ? row.source_hint : undefined,
  };
}

export async function POST(request: Request, context: Context) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    const caseRow = await ownedCase(db, user, id);
    const missingGroups = readMissingDocumentGroups(caseRow.processing_meta);
    if (!missingGroups.length) {
      throw new ApiError(
        "This case no longer has a missing-document issue. Refresh the case before adding files.",
        409,
      );
    }
    if (caseRow.status === "processing") {
      throw new ApiError(
        "Wait for the current analysis to finish before adding documents.",
        409,
      );
    }
    if (caseRow.status === "accepted" || caseRow.status === "rejected") {
      throw new ApiError("A finalized case cannot be changed.", 409);
    }

    const body = await jsonBody(request);
    await ensureCaseFilePageCounts(db, user, id);
    const uploadIds = await verifyUploads(db, user, body.uploadIds);
    const [assetResult, documentResult] = await Promise.all([
      db
        .from("storage_assets")
        .select("id, storage_path, original_name, content_sha256, mime_type")
        .eq("owner_user_id", user)
        .in("id", uploadIds),
      db
        .from("packet_documents")
        .select(
          "id, client_document_id, source_file_name, source_hint, document_type, title, page_count, extracted_fields, markdown",
        )
        .eq("case_id", id)
        .order("created_at"),
    ]);
    dbCheck(assetResult.error);
    dbCheck(documentResult.error);

    if (!documentResult.data?.length) {
      throw new ApiError(
        "The current case has no analyzed documents to compare against. Run case analysis first.",
        409,
      );
    }

    const assetsById = new Map(
      (assetResult.data ?? []).map((asset) => [
        asset.id,
        asset as StorageAsset,
      ]),
    );
    const assets = uploadIds.map((uploadId) => assetsById.get(uploadId));
    if (assets.some((asset) => !asset)) {
      throw new ApiError("One or more staged uploads were not found.", 404);
    }

    const candidates: MissingDocumentCandidate[] = [];
    try {
      for (const asset of assets as StorageAsset[]) {
        const download = await db.storage
          .from("packet-files")
          .download(asset.storage_path);
        if (download.error || !download.data) throw download.error;

        const bytes = new Uint8Array(await download.data.arrayBuffer());
        const checksum = createHash("sha256").update(bytes).digest("hex");
        if (checksum !== asset.content_sha256) {
          throw new Error(`Upload checksum failed for ${asset.original_name}.`);
        }

        const extracted = await extractUploadedPacketFile({
          bytes,
          fileName: asset.original_name,
          mimeType: asset.mime_type,
        });
        candidates.push({
          sourceFileName: asset.original_name,
          documents: extracted.documents,
          pageImages: extracted.reviewImages,
        });
      }
    } catch (error) {
      console.warn(
        "Missing-document upload extraction failed",
        error instanceof Error ? error.message : error,
      );
      throw new ApiError(
        "We could not reliably read the selected document, so it was not added. Check the file quality and try again.",
        422,
      );
    }

    let fileDecisions;
    try {
      fileDecisions = await reviewMissingDocumentUploads({
        currentDocuments: documentResult.data.map((row) =>
          toCurrentDocument(row as Record<string, unknown>),
        ),
        candidates,
        missingGroups,
      });
    } catch (error) {
      console.warn(
        "Missing-document upload review failed",
        error instanceof Error ? error.message : error,
      );
      throw new ApiError(
        "The reviewer could not verify this document, so it was not added. Please retry; the existing case is unchanged.",
        503,
      );
    }

    const decisionsByName = new Map(
      fileDecisions.map((decision) => [decision.sourceFileName, decision]),
    );
    const acceptedAssets = (assets as StorageAsset[]).filter(
      (asset) =>
        decisionsByName.get(asset.original_name)?.decision === "accepted",
    );
    const satisfiedGroups = Array.from(
      new Set(
        acceptedAssets.flatMap(
          (asset) =>
            decisionsByName.get(asset.original_name)?.satisfiedMissingGroups ??
            [],
        ),
      ),
    );
    const remainingGroups = missingGroups.filter(
      (group) => !satisfiedGroups.includes(group),
    );

    let updatedCase = null;
    if (acceptedAssets.length > 0) {
      const attached = await db.rpc("attach_case_uploads", {
        p_user: user,
        p_upload_ids: acceptedAssets.map((asset) => asset.id),
        p_case_id: id,
        p_mode: "append",
        p_allow_duplicate: true,
      });
      dbCheck(attached.error);
      updatedCase = mapCase(attached.data.case);
    }

    const rejectedCount = fileDecisions.length - acceptedAssets.length;
    const overallDecision =
      acceptedAssets.length > 0 && rejectedCount > 0
        ? "partially_accepted"
        : acceptedAssets.length > 0
          ? "accepted"
          : fileDecisions.some(
                (decision) => decision.decision === "needs_review",
              )
            ? "needs_review"
            : "rejected";

    const eventResult = await db.from("case_review_events").insert({
      case_id: id,
      owner_user_id: user,
      action: "missing_document_upload_reviewed",
      details: {
        overallDecision,
        missingGroups,
        satisfiedGroups,
        files: fileDecisions,
      },
    });
    dbCheck(eventResult.error);

    return {
      decision: overallDecision,
      case: updatedCase,
      files: fileDecisions,
      acceptedFileNames: acceptedAssets.map((asset) => asset.original_name),
      rejectedFileNames: fileDecisions
        .filter((decision) => decision.decision !== "accepted")
        .map((decision) => decision.sourceFileName),
      satisfiedGroups,
      remainingGroups,
    };
  });
}
