"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  fetchCaseFileSignedUrl,
  type SavedCaseFile,
} from "@/lib/case-persistence";
import { PdfDocumentPreview } from "./PdfDocumentPreview";

export function SavedDocumentDialog({
  caseId,
  file,
  onClose,
}: {
  caseId: string;
  file: SavedCaseFile | null;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setUrl(null);
    setError("");
    if (file)
      void fetchCaseFileSignedUrl(caseId, file.id)
        .then((result) => {
          if (!result.signedUrl) throw new Error("No source URL available");
          if (active) setUrl(result.signedUrl);
        })
        .catch(() => {
          if (active)
            setError(
              "Could not open this document. Close the preview and try again.",
            );
        });
    return () => {
      active = false;
    };
  }, [caseId, file]);
  return (
    <Dialog
      open={Boolean(file)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[92dvh] max-w-5xl flex-col gap-3 rounded-2xl p-4 sm:p-6">
        <DialogHeader className="pr-10">
          <DialogTitle className="break-all text-base">
            {file?.originalName}
          </DialogTitle>
          <DialogDescription>
            Original document saved to this case.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="p-6 text-sm text-red-700">
            {error}
          </p>
        ) : !url ? (
          <p
            role="status"
            className="flex items-center justify-center gap-2 p-12 text-sm"
          >
            <Loader2 className="h-5 w-5 animate-spin" />
            Opening document…
          </p>
        ) : file?.mimeType?.startsWith("image/") ? (
          <>
            <Image
              src={url}
              alt={file.originalName}
              width={1200}
              height={1600}
              unoptimized
              className="max-h-[65dvh] min-h-0 w-full object-contain"
            />
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-emerald-700 underline"
            >
              Open original
            </a>
          </>
        ) : (
          <PdfDocumentPreview
            url={url}
            title={file?.originalName || "Document"}
            className="h-[65dvh]"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
