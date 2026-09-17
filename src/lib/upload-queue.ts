import type { QueuedUpload } from "@/types/pipeline";
import { getQueuedUploadFiles } from "./upload-groups";

export type DuplicateUploadStrategy = "prompt" | "overwrite" | "duplicate";
export type DuplicateUploadConflict = {
  id: string;
  file: File;
  existingUpload: QueuedUpload;
};
export const DOCUMENT_UPLOAD_ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif";
export const IMAGE_UPLOAD_ACCEPT = ".jpg,.jpeg,.png,.webp,.heic,.heif";
const nameKey = (name: string) => name.trim().toLowerCase();

export function validateUploadFiles(files: File[]) {
  if (
    files.some((file) => !/\.(pdf|jpe?g|png|webp|heic|heif)$/i.test(file.name))
  )
    throw new Error("Choose PDF, JPG, PNG, WebP or HEIC documents.");
  if (files.some((file) => file.size === 0))
    throw new Error("Empty files cannot be uploaded.");
  if (files.some((file) => file.size > 50 * 1024 * 1024))
    throw new Error("Each file must be 50 MB or smaller.");
  if (files.length > 20) throw new Error("Add up to 20 files per case.");
  if (files.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024)
    throw new Error("A case can contain up to 100 MB of files.");
}

export function planUploadQueue(
  current: QueuedUpload[],
  incoming: File[],
  strategy: DuplicateUploadStrategy = "prompt",
) {
  const uploads = [...current];
  const acceptedUploads: QueuedUpload[] = [];
  const conflicts: DuplicateUploadConflict[] = [];
  for (const source of incoming) {
    let file = source;
    const existingIndex = uploads.findIndex(
      (upload) => nameKey(upload.name) === nameKey(file.name),
    );
    const existingUpload = uploads[existingIndex];
    if (existingUpload && strategy === "prompt") {
      conflicts.push({ id: crypto.randomUUID(), file, existingUpload });
      continue;
    }
    if (existingUpload && strategy === "duplicate") {
      const dot = file.name.lastIndexOf(".");
      const base = dot > 0 ? file.name.slice(0, dot) : file.name;
      const extension = dot > 0 ? file.name.slice(dot) : "";
      let number = 2;
      let name = `${base} (${number})${extension}`;
      while (uploads.some((upload) => nameKey(upload.name) === nameKey(name)))
        name = `${base} (${++number})${extension}`;
      file = new File([file], name, {
        type: file.type,
        lastModified: file.lastModified,
      });
    }
    const upload: QueuedUpload = {
      id: crypto.randomUUID(),
      name: file.name,
      file,
      files: [file],
      source: "file",
      stages: [],
    };
    if (existingUpload && strategy === "overwrite") {
      uploads[existingIndex] = upload;
      const acceptedIndex = acceptedUploads.findIndex(
        (item) => nameKey(item.name) === nameKey(upload.name),
      );
      if (acceptedIndex >= 0) acceptedUploads.splice(acceptedIndex, 1);
    } else uploads.push(upload);
    acceptedUploads.push(upload);
  }
  validateUploadFiles(uploads.flatMap(getQueuedUploadFiles));
  return { uploads, acceptedUploads, conflicts };
}
