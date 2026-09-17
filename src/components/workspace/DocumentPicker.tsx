"use client";

import { useEffect, useRef, useState } from "react";
import {
  Camera,
  FolderPlus,
  ImagePlus,
  Loader2,
  Plus,
  UploadCloud,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DOCUMENT_UPLOAD_ACCEPT,
  IMAGE_UPLOAD_ACCEPT,
} from "@/lib/upload-queue";
import { createScanDocument } from "@/lib/client-scan-pdf";
import { normalizeUploadFiles } from "@/lib/client-image-upload";

type Props = {
  onFiles: (files: File[]) => Promise<void>;
  disabled?: boolean;
  compact?: boolean;
  actionLabel?: string;
  maxFiles?: number;
  maxScanPages?: number;
};
type ScanPage = { file: File; url: string };

export function DocumentPicker({
  onFiles,
  disabled = false,
  compact = false,
  actionLabel = "Add documents",
  maxFiles = 20,
  maxScanPages = 40,
}: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const phoneInput = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const pagesRef = useRef<ScanPage[]>([]);
  const session = useRef(0);
  const captureBusy = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraOpening, setCameraOpening] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [pages, setPages] = useState<ScanPage[]>([]);
  const stopCamera = () => {
    session.current++;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  };
  useEffect(
    () => () => {
      session.current++;
      stream.current?.getTracks().forEach((track) => track.stop());
      pagesRef.current.forEach((page) => URL.revokeObjectURL(page.url));
    },
    [],
  );
  function clearPages() {
    pagesRef.current.forEach((page) => URL.revokeObjectURL(page.url));
    pagesRef.current = [];
    setPages([]);
  }
  function closeCamera() {
    if (captureBusy.current) return;
    stopCamera();
    clearPages();
    setCameraOpen(false);
    setCameraReady(false);
    setCameraOpening(false);
  }
  async function openCamera() {
    setMenuOpen(false);
    setCameraError("");
    setCameraOpen(true);
    setCameraReady(false);
    setCameraOpening(true);
    const request = ++session.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("Camera unavailable");
      const media = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      if (request !== session.current) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      if (video.current) {
        video.current.srcObject = media;
        await video.current.play();
      }
      setCameraReady(true);
    } catch {
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      if (request === session.current)
        setCameraError(
          "Could not open the camera. Allow camera access in your browser, or choose photos below.",
        );
    } finally {
      if (request === session.current) setCameraOpening(false);
    }
  }
  async function capturePage() {
    if (
      !video.current ||
      captureBusy.current ||
      !cameraReady ||
      pagesRef.current.length >= maxScanPages
    )
      return;
    captureBusy.current = true;
    setSaving(true);
    setCameraError("");
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.current.videoWidth;
      canvas.height = video.current.videoHeight;
      const context = canvas.getContext("2d");
      if (!context || !canvas.width || !canvas.height)
        throw new Error("The camera is not ready. Please try again.");
      context.drawImage(video.current, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.92),
      );
      if (!blob)
        throw new Error("Could not capture this page. Please try again.");
      const file = new File([blob], `page-${pagesRef.current.length + 1}.jpg`, {
        type: "image/jpeg",
      });
      const next = [
        ...pagesRef.current,
        { file, url: URL.createObjectURL(file) },
      ];
      pagesRef.current = next;
      setPages(next);
    } catch (error) {
      setCameraError(
        error instanceof Error ? error.message : "Could not capture this page.",
      );
    } finally {
      captureBusy.current = false;
      setSaving(false);
    }
  }
  async function addChosenPages(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!selected.length || captureBusy.current) return;

    const remaining = maxScanPages - pagesRef.current.length;
    if (selected.length > remaining) {
      setCameraError(
        `This scan can contain up to ${maxScanPages} ${maxScanPages === 1 ? "page" : "pages"}. Choose ${remaining} or fewer additional photos.`,
      );
      return;
    }

    captureBusy.current = true;
    setSaving(true);
    setCameraError("");
    try {
      const files = await normalizeUploadFiles(selected);
      const additions = files.map((file) => ({
        file,
        url: URL.createObjectURL(file),
      }));
      const next = [...pagesRef.current, ...additions];
      pagesRef.current = next;
      setPages(next);
    } catch (error) {
      setCameraError(
        error instanceof Error
          ? error.message
          : "Could not add the selected photo.",
      );
    } finally {
      captureBusy.current = false;
      setSaving(false);
    }
  }
  async function finishScan() {
    if (!pagesRef.current.length || captureBusy.current) return;
    captureBusy.current = true;
    setSaving(true);
    setCameraError("");
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = await createScanDocument(
        pagesRef.current.map((page) => page.file),
        `Scanned-document-${stamp}.pdf`,
      );
      await onFiles([file]);
      captureBusy.current = false;
      closeCamera();
    } catch (error) {
      setCameraError(
        error instanceof Error ? error.message : "Could not save this scan.",
      );
    } finally {
      captureBusy.current = false;
      setSaving(false);
    }
  }
  const choose = (input: React.RefObject<HTMLInputElement | null>) => {
    setMenuOpen(false);
    input.current?.click();
  };
  const inputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length > maxFiles) {
      void onFiles([]).catch(() => {});
      return;
    }
    if (files.length) void onFiles(files).catch(() => {}); // The parent displays upload failures without losing its queue.
  };
  const choices = [
    {
      label: "Upload PDF/Image",
      icon: UploadCloud,
      action: () => choose(fileInput),
    },
    {
      label: "Choose from gallery",
      icon: ImagePlus,
      action: () => choose(galleryInput),
    },
    { label: "Scan document", icon: Camera, action: () => void openCamera() },
  ];
  return (
    <>
      <input
        ref={fileInput}
        aria-label="Upload case files"
        type="file"
        multiple={maxFiles > 1}
        accept={DOCUMENT_UPLOAD_ACCEPT}
        className="hidden"
        disabled={disabled}
        onChange={inputChange}
      />
      <input
        ref={galleryInput}
        aria-label="Choose case images"
        type="file"
        multiple={maxFiles > 1}
        accept={IMAGE_UPLOAD_ACCEPT}
        className="hidden"
        disabled={disabled}
        onChange={inputChange}
      />
      <input
        ref={phoneInput}
        aria-label="Take a document photo"
        type="file"
        multiple
        accept={IMAGE_UPLOAD_ACCEPT}
        capture="environment"
        className="hidden"
        disabled={disabled || saving}
        onChange={(event) => void addChosenPages(event)}
      />
      {compact ? (
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              disabled={disabled}
              className="rounded-2xl border-[#e5ddd0] bg-white px-6 py-6 text-base font-bold text-[#5a5046] shadow-sm"
            >
              <Plus className="mr-2 h-5 w-5" />
              {actionLabel}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="center"
            className="w-60 rounded-2xl border-[#e5ddd0] bg-white p-2 shadow-xl"
          >
            {choices.map(({ label, icon: Icon, action }) => (
              <button
                key={label}
                type="button"
                onClick={action}
                disabled={disabled}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-bold text-[#5a5046] hover:bg-[#faf8f4] disabled:opacity-50"
              >
                <Icon className="h-4 w-4 shrink-0 text-[#8a7f72]" />
                {label}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      ) : (
        <div className="mx-auto mt-6 flex flex-wrap justify-center gap-3">
          {choices.map(({ label, icon: Icon, action }, index) => (
            <Button
              key={label}
              disabled={disabled}
              variant={index === 0 ? "default" : "outline"}
              onClick={action}
              className={`rounded-xl px-5 py-5 text-base font-bold shadow-sm ${index === 0 ? "bg-[#1a1a1a] text-white shadow-lg shadow-[#1a1a1a]/15 hover:bg-[#2d2d2d]" : "border-[#e5ddd0] bg-white text-[#5a5046] hover:bg-[#faf8f4]"}`}
            >
              <Icon className="mr-2 h-5 w-5" />
              {label}
            </Button>
          ))}
        </div>
      )}
      <Dialog
        open={cameraOpen}
        onOpenChange={(open) => {
          if (!open) closeCamera();
        }}
      >
        <DialogContent
          className="max-h-[90dvh] max-w-3xl overflow-y-auto rounded-3xl p-5"
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Scan document</DialogTitle>
            <DialogDescription>
              {maxScanPages === 1
                ? "Capture one clear replacement page. Finish to save it as a PDF."
                : "Capture each page in order. Finish to save them together as one PDF."}
            </DialogDescription>
          </DialogHeader>
          <div className="relative mt-4 overflow-hidden rounded-2xl bg-slate-950">
            <video
              ref={video}
              autoPlay
              playsInline
              muted
              className="max-h-[42dvh] min-h-40 w-full object-contain"
            />
            {cameraOpening && (
              <div
                role="status"
                className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white"
              >
                <Loader2 className="h-5 w-5 animate-spin" />
                Opening camera…
              </div>
            )}
          </div>
          {cameraError && (
            <p role="alert" className="mt-3 text-sm text-red-700">
              {cameraError}
            </p>
          )}
          {pages.length > 0 && (
            <ol
              className="mt-3 flex gap-3 overflow-x-auto p-2"
              aria-label="Scanned pages"
            >
              {pages.map((page, index) => (
                <li key={page.url} className="relative shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={page.url}
                    alt={`Scanned page ${index + 1}`}
                    className="h-24 w-20 rounded-lg border object-cover"
                  />
                  <span className="absolute bottom-1 left-1 rounded bg-white px-1 text-xs">
                    {index + 1}
                  </span>
                  <button
                    aria-label={`Remove scanned page ${index + 1}`}
                    disabled={saving}
                    onClick={() => {
                      URL.revokeObjectURL(page.url);
                      const next = pagesRef.current.filter(
                        (item) => item !== page,
                      );
                      pagesRef.current = next;
                      setPages(next);
                    }}
                    className="absolute -right-2 -top-2 rounded-full bg-white p-1 shadow"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <p role="status" className="mt-2 text-xs text-slate-500">
            {pages.length} / {maxScanPages}{" "}
            {maxScanPages === 1 ? "page" : "pages"} captured
          </p>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={saving} onClick={closeCamera}>
              Discard scan
            </Button>
            {!cameraReady && (
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => phoneInput.current?.click()}
              >
                <ImagePlus className="h-4 w-4" />
                Take or choose photo
              </Button>
            )}
            <Button
              variant="outline"
              disabled={!cameraReady || saving || pages.length >= maxScanPages}
              onClick={() => void capturePage()}
            >
              <Camera className="h-4 w-4" />
              Capture page
            </Button>
            <Button
              disabled={!pages.length || saving}
              onClick={() => void finishScan()}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FolderPlus className="h-4 w-4" />
              )}
              Finish document
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
