import type { QueuedUpload } from "@/types/pipeline";

export type DraftCaseFile = {
  id: string;
  originalName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string;
};

const fileNameKey = (name: string) => name.trim().toLocaleLowerCase();

export function linkDraftCaseFiles(
  uploads: QueuedUpload[],
  files: DraftCaseFile[],
) {
  const byName = new Map(
    files.map((file) => [fileNameKey(file.originalName), file.id]),
  );

  return uploads.map((upload) => ({
    ...upload,
    caseFileId: byName.get(fileNameKey(upload.name)),
  }));
}
