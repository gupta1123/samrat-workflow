"use client";

import { useEffect, useState } from "react";
import { PdfDocumentPreview } from "./PdfDocumentPreview";
import { FileText, RefreshCw, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { QueuedUpload } from "@/types/pipeline";
import { DOCUMENT_UPLOAD_ACCEPT } from "@/lib/upload-queue";

export function QueuedDocumentRail({
  uploads,
  saved,
  editable,
  disabled,
  onRemove,
  onReplace,
}: {
  uploads: QueuedUpload[];
  saved: boolean;
  editable: boolean;
  disabled: boolean;
  onRemove: (id: string) => void | Promise<void>;
  onReplace: (id: string, file: File) => void | Promise<void>;
}) {
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    const urls = Object.fromEntries(
      uploads
        .filter((upload) => upload.file)
        .map((upload) => [upload.id, URL.createObjectURL(upload.file!)]),
    );
    setPreviews(urls);
    return () => Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
  }, [uploads]);
  const selected = uploads.find((upload) => upload.id === selectedId);
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2 text-left">
        <span className="text-sm font-bold text-[#1a1a1a]">
          Documents in this case
        </span>
        <span className="text-[11px] font-bold uppercase tracking-wider text-[#8a7f72]">
          {uploads.length} {uploads.length === 1 ? "document" : "documents"}
        </span>
      </div>
      <p className="sr-only">
        Select a document to preview.{" "}
        {saved ? "Documents are saved." : "Documents are selected for upload."}
      </p>
      {uploads.length ? (
        <ol
          className="flex flex-wrap justify-start gap-x-4 gap-y-3 py-2"
          aria-label="Case documents"
        >
          {uploads.map((upload, index) => {
            const controlDisabled = disabled || (saved && !upload.caseFileId);
            const replaceInputId = `replace-${upload.id}`;
            return (
              <li
                key={upload.id}
                className="group relative flex w-16 flex-col items-center"
              >
                <button
                  type="button"
                  aria-label={`Preview ${upload.name}`}
                  title={upload.name}
                  onClick={() => setSelectedId(upload.id)}
                  className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border border-[#e5ddd0] bg-white text-[#8a7f72] shadow-sm transition hover:border-[#8a7f72] hover:shadow-md focus-visible:outline-2 focus-visible:outline-emerald-600"
                >
                  {upload.file?.type.startsWith("image/") &&
                  previews[upload.id] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={previews[upload.id]}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <FileText className="h-7 w-7" />
                  )}
                  <span className="absolute bottom-0 left-0 right-0 bg-white/90 text-[10px] font-bold text-slate-700">
                    {index + 1} ·{" "}
                    {upload.file?.type.startsWith("image/") ? "Image" : "PDF"}
                  </span>
                </button>
                {editable && (
                  <button
                    type="button"
                    disabled={controlDisabled}
                    aria-label={`Remove ${upload.name}`}
                    title={`Remove ${upload.name}`}
                    onClick={() => void onRemove(upload.id)}
                    className="absolute -right-1.5 -top-2 rounded-full border border-[#e5ddd0] bg-white p-1.5 text-[#8a7f72] shadow-sm transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-red-600 disabled:opacity-40"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
                {editable && (
                  <>
                    <input
                      id={replaceInputId}
                      aria-label={`Replace ${upload.name}`}
                      type="file"
                      accept={DOCUMENT_UPLOAD_ACCEPT}
                      disabled={controlDisabled}
                      className="sr-only"
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (file) void onReplace(upload.id, file);
                      }}
                    />
                    <label
                      htmlFor={replaceInputId}
                      title={`Replace ${upload.name}`}
                      aria-disabled={controlDisabled}
                      className={`mt-2 inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-bold text-[#5a5046] transition hover:bg-[#f0ece6] hover:text-[#1a1a1a] focus-within:outline-2 focus-within:outline-emerald-600 ${controlDisabled ? "pointer-events-none opacity-40" : ""}`}
                    >
                      <RefreshCw className="h-3 w-3" />
                      Replace
                    </label>
                  </>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="rounded-2xl border border-dashed border-[#e5ddd0] bg-[#faf8f4] px-4 py-5 text-center text-sm font-medium text-[#8a7f72]">
          No documents added yet.
        </div>
      )}
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <DialogContent className="flex max-h-[92dvh] max-w-5xl flex-col gap-3 rounded-2xl p-4 sm:p-6">
          <DialogHeader className="pr-10">
            <DialogTitle className="break-all text-base">
              {selected?.name}
            </DialogTitle>
            <DialogDescription>
              {saved ? "Saved to this case" : "Selected for upload"} · Not
              analyzed yet
            </DialogDescription>
          </DialogHeader>
          {selected &&
            previews[selected.id] &&
            (selected.file?.type.startsWith("image/") ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previews[selected.id]}
                alt={selected.name}
                className="max-h-[68dvh] min-h-0 w-full rounded-xl bg-slate-100 object-contain"
              />
            ) : (
              <PdfDocumentPreview
                url={previews[selected.id]}
                title={selected.name}
                className="h-[65dvh]"
              />
            ))}
          {selected && (
            <a
              href={previews[selected.id]}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-medium text-emerald-700 underline"
            >
              Open original in a new tab
            </a>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
