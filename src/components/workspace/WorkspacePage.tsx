"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Folder,
  FolderPlus,
  Loader2,
  UploadCloud,
} from "lucide-react";
import { AppShell } from "@/components/dashboard/AppShell";
import { Button } from "@/components/ui/button";
import { AnalysisOptionsDialog } from "./AnalysisOptionsDialog";
import { AnalysisModeActions } from "./AnalysisModeActions";
import { DuplicateUploadDialog } from "./DuplicateUploadDialog";
import { DocumentPicker } from "./DocumentPicker";
import { QueuedDocumentRail } from "./QueuedDocumentRail";
import {
  appendCaseFiles,
  createDraftCase,
  enqueueCaseAnalysis,
  getDuplicateCaseFromError,
  removeDraftCaseFile,
  replaceDraftCaseFile,
  type DuplicateCaseReference,
  type SavedCaseRecord,
} from "@/lib/case-persistence";
import { normalizeUploadFiles } from "@/lib/client-image-upload";
import { linkDraftCaseFiles } from "@/lib/draft-case-files";
import {
  DOCUMENT_UPLOAD_ACCEPT,
  planUploadQueue,
  validateUploadFiles,
  type DuplicateUploadConflict,
  type DuplicateUploadStrategy,
} from "@/lib/upload-queue";
import type {
  CaseAnalysisMode,
  ComparisonOptions,
  QueuedUpload,
} from "@/types/pipeline";

export function WorkspacePage() {
  const router = useRouter();
  const browseInput = useRef<HTMLInputElement>(null);
  const readySection = useRef<HTMLElement>(null);
  const busyRef = useRef(false);
  const queueRef = useRef<QueuedUpload[]>([]);
  const dragDepth = useRef(0);
  const [uploads, setUploads] = useState<QueuedUpload[]>([]);
  const [savedCase, setSavedCase] = useState<SavedCaseRecord | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [duplicateCase, setDuplicateCase] =
    useState<DuplicateCaseReference | null>(null);
  const [conflicts, setConflicts] = useState<DuplicateUploadConflict[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [analysisMode, setAnalysisMode] =
    useState<CaseAnalysisMode>("standard");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [comparisonOptions, setComparisonOptions] = useState<ComparisonOptions>(
    { considerFormatting: false },
  );
  const disabled = Boolean(busy) || conflicts.length > 0;
  useEffect(() => {
    if (savedCase) readySection.current?.scrollIntoView({ block: "start" });
  }, [savedCase]);
  function updateQueue(next: QueuedUpload[]) {
    queueRef.current = next;
    setUploads(next);
  }
  useEffect(() => {
    if (!uploads.length || savedCase) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploads.length, savedCase]);

  async function addFiles(
    files: File[],
    strategy: DuplicateUploadStrategy = "prompt",
  ) {
    if (!files.length || busyRef.current) return;
    busyRef.current = true;
    setBusy(savedCase ? "Adding documents to case…" : "Preparing documents…");
    setError("");
    setDuplicateCase(null);
    try {
      validateUploadFiles(files);
      const normalized = await normalizeUploadFiles(files);
      const plan = planUploadQueue(queueRef.current, normalized, strategy);
      // Commit the visible queue only after the server has atomically attached the new files.
      if (savedCase && plan.acceptedUploads.length) {
        const response = await appendCaseFiles(
          savedCase.id,
          plan.acceptedUploads,
          strategy === "overwrite" ? "overwrite" : "append",
        );
        setSavedCase(response.case);
        updateQueue(linkDraftCaseFiles(plan.uploads, response.files));
      } else {
        updateQueue(plan.uploads);
      }
      setConflicts(plan.conflicts);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not add these documents. Your existing files have been kept.",
      );
      throw failure;
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }
  async function createCase() {
    if (!queueRef.current.length || busyRef.current || conflicts.length) return;
    busyRef.current = true;
    setBusy("Creating case…");
    setError("");
    setDuplicateCase(null);
    try {
      const response = await createDraftCase({ uploads: queueRef.current });
      setSavedCase(response.case);
      updateQueue(linkDraftCaseFiles(queueRef.current, response.files));
    } catch (failure) {
      const duplicate = getDuplicateCaseFromError(failure);
      if (duplicate) setDuplicateCase(duplicate);
      else
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not create the case. Your selected files have been kept; please retry.",
        );
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }
  async function analyze(options: ComparisonOptions) {
    if (!savedCase || busyRef.current || conflicts.length) return;
    busyRef.current = true;
    setOptionsOpen(false);
    setComparisonOptions(options);
    setError("");
    setBusy("Starting analysis…");
    try {
      await enqueueCaseAnalysis(savedCase.id, {
        analysisMode,
        comparisonOptions: options,
      });
      router.replace(`/cases/${savedCase.id}`);
      // Keep actions locked until navigation; a second click must not enqueue another job.
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not start analysis. Your case is saved; please retry.",
      );
      busyRef.current = false;
      setBusy("");
    }
  }
  function requestAnalysis(mode: CaseAnalysisMode) {
    setAnalysisMode(mode);
    setOptionsOpen(true);
  }
  async function removeUpload(id: string) {
    if (busyRef.current) return;
    const upload = queueRef.current.find((item) => item.id === id);
    if (!upload) return;
    if (!savedCase) {
      updateQueue(queueRef.current.filter((item) => item.id !== id));
      setDuplicateCase(null);
      setError("");
      return;
    }
    if (!upload.caseFileId) {
      setError(
        "This document could not be matched to the saved case. Refresh and try again.",
      );
      return;
    }

    busyRef.current = true;
    setBusy(`Removing ${upload.name}…`);
    setError("");
    try {
      const response = await removeDraftCaseFile(
        savedCase.id,
        upload.caseFileId,
      );
      setSavedCase(response.case);
      updateQueue(
        linkDraftCaseFiles(
          queueRef.current.filter((item) => item.id !== id),
          response.files,
        ),
      );
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not remove this document. It is still in the case.",
      );
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }
  async function replaceUpload(id: string, file: File) {
    if (busyRef.current) return;
    const current = queueRef.current.find((item) => item.id === id);
    if (!current) return;

    busyRef.current = true;
    setBusy(`Replacing ${current.name}…`);
    setError("");
    try {
      validateUploadFiles([file]);
      const normalized = await normalizeUploadFiles([file]);
      const plan = planUploadQueue(
        queueRef.current.filter((item) => item.id !== id),
        normalized,
      );
      if (plan.conflicts.length)
        throw new Error(
          "A document with that name is already in this case. Rename the replacement and try again.",
        );
      const replacement = plan.acceptedUploads[0];
      if (!replacement)
        throw new Error("Choose one PDF or image to replace this document.");

      const nextUploads = queueRef.current.map((item) =>
        item.id === id ? replacement : item,
      );
      if (!savedCase) {
        updateQueue(nextUploads);
        return;
      }
      if (!current.caseFileId)
        throw new Error(
          "This document could not be matched to the saved case. Refresh and try again.",
        );

      const response = await replaceDraftCaseFile(
        savedCase.id,
        current.caseFileId,
        replacement,
      );
      setSavedCase(response.case);
      updateQueue(linkDraftCaseFiles(nextUploads, response.files));
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not replace this document. The original is still in the case.",
      );
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }
  const notices = (
    <>
      {busy && (
        <p
          role="status"
          className="mt-4 flex items-center justify-center gap-2 text-sm font-medium text-[#5a5046]"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          {busy}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700"
        >
          {error}
          {savedCase && (
            <Link className="ml-2 underline" href={`/cases/${savedCase.id}`}>
              Open saved case
            </Link>
          )}
        </div>
      )}
      {duplicateCase && (
        <div
          role="alert"
          className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-left text-sm text-amber-900"
        >
          <p className="font-semibold">This packet already belongs to a case</p>
          <p className="mt-2">
            Open {duplicateCase.displayName} to continue its review, or clear
            these files to upload a different packet.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Button asChild>
              <Link href={`/cases/${duplicateCase.id}`}>
                Open existing case
              </Link>
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                updateQueue([]);
                setDuplicateCase(null);
              }}
            >
              Clear selected files
            </Button>
          </div>
        </div>
      )}
    </>
  );
  const rail = (
    <QueuedDocumentRail
      uploads={uploads}
      saved={Boolean(savedCase)}
      editable
      disabled={disabled}
      onRemove={removeUpload}
      onReplace={replaceUpload}
    />
  );
  return (
    <AppShell>
      {!savedCase ? (
        <div className="flex min-h-screen flex-col bg-[#f7f7f5] px-4 pb-20 text-[#1a1a1a] sm:px-6 md:pb-8">
          <header className="mx-auto mb-5 w-full max-w-2xl border-b border-[#e5ddd0] pb-4 pt-5">
            <div className="flex items-center gap-3 sm:gap-4">
              <div className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[#e5ddd0] bg-[#f0ece6] shadow-sm sm:flex">
                <UploadCloud className="h-6 w-6" />
              </div>
              <div>
                <h1 className="text-lg font-bold sm:text-xl">
                  Add case documents
                </h1>
                <p className="mt-0.5 text-xs font-medium leading-snug text-[#8a7f72] sm:text-sm">
                  Upload or scan the documents for one case.
                </p>
              </div>
            </div>
          </header>
          <div className="flex flex-1 items-center justify-center">
            <div className="w-full max-w-2xl">
              <div
                className={`w-full rounded-[2rem] border-2 border-dashed px-5 py-7 text-center shadow-sm transition-all sm:px-8 sm:py-8 ${dragActive ? "border-[#22c55e] bg-[#f0fdf4] ring-4 ring-emerald-100" : "border-[#e5ddd0] bg-white hover:border-[#d4c9b8] hover:shadow-md"}`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  if (!disabled) {
                    dragDepth.current++;
                    setDragActive(true);
                  }
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => {
                  event.preventDefault();
                  dragDepth.current--;
                  if (dragDepth.current <= 0) setDragActive(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  dragDepth.current = 0;
                  setDragActive(false);
                  if (!disabled)
                    void addFiles(Array.from(event.dataTransfer.files)).catch(
                      () => {},
                    );
                }}
              >
                <div
                  className={`mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-[1.25rem] border shadow-sm ${dragActive ? "border-[#bbf7d0] bg-white text-[#15803d]" : "border-[#e5ddd0] bg-[#f0ece6]"}`}
                >
                  <UploadCloud className="h-7 w-7" />
                </div>
                <h2 className="text-2xl font-extrabold sm:text-3xl">
                  {dragActive ? "Drop files to add them" : "Upload case packet"}
                </h2>
                <p className="mt-2 text-base font-medium text-[#5a5046]">
                  Drag and drop PDFs/images here, or{" "}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => browseInput.current?.click()}
                    className="font-bold text-[#15803d] hover:underline disabled:opacity-50"
                  >
                    click to browse
                  </button>
                </p>
                <input
                  ref={browseInput}
                  aria-label="Browse case files"
                  type="file"
                  multiple
                  accept={DOCUMENT_UPLOAD_ACCEPT}
                  disabled={disabled}
                  className="hidden"
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = "";
                    void addFiles(files).catch(() => {});
                  }}
                />
                <div className="mx-auto mt-5 flex max-w-2xl flex-wrap justify-center gap-2">
                  {[
                    "PDF",
                    "JPG",
                    "PNG",
                    "WEBP",
                    "HEIC",
                    "Tax Invoice",
                    "PO",
                    "E-Way Bill",
                    "Receipt",
                    "Delivery Note",
                  ].map((label) => (
                    <span
                      key={label}
                      className={`rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wider ${label === "PDF" || label === "Tax Invoice" ? "border-[#c9ead2] bg-[#eaf7ee] text-[#15803d]" : "border-[#e5ddd0] bg-[#faf8f4] text-[#5a5046]"}`}
                    >
                      {label}
                    </span>
                  ))}
                </div>
                <DocumentPicker disabled={disabled} onFiles={addFiles} />
              </div>
              {notices}
              {uploads.length > 0 && (
                <div className="mt-5 flex flex-col items-center">
                  <div className="w-full rounded-[1.5rem] border border-[#e5ddd0] bg-white p-4 shadow-sm">
                    {rail}
                  </div>
                  <Button
                    size="lg"
                    disabled={disabled}
                    onClick={() => void createCase()}
                    className="mt-4 w-full max-w-md rounded-2xl bg-[#1a1a1a] px-8 py-6 text-base font-bold text-white shadow-lg shadow-[#1a1a1a]/15 hover:bg-[#2d2d2d]"
                  >
                    {busy ? (
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    ) : (
                      <FolderPlus className="mr-2 h-5 w-5" />
                    )}
                    Create case
                  </Button>
                </div>
              )}
              <p className="mt-4 text-center text-[11px] text-[#8a7f72]">
                Up to 20 files · 50 MB per file · 100 MB and 40 pages per case
              </p>
            </div>
          </div>
        </div>
      ) : (
        <section
          ref={readySection}
          className="flex min-h-screen items-center justify-center bg-[#f7f7f5]"
        >
          <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-8 px-6 py-16 text-center">
            <div className="grid h-16 w-16 place-items-center rounded-[1.25rem] border border-[#c9ead2] bg-[#eaf7ee] text-[#15803d] shadow-sm">
              <CheckCircle2 className="h-8 w-8" />
            </div>
            <div className="max-w-2xl space-y-4">
              <p className="text-xs font-bold uppercase tracking-[0.3em] text-[#8a7f72]">
                Case created
              </p>
              <h1 className="text-4xl font-extrabold tracking-tight text-[#1a1a1a] sm:text-5xl">
                Ready to analyze
              </h1>
              <p className="text-base font-medium leading-relaxed text-[#5a5046]">
                This case has {uploads.length}{" "}
                {uploads.length === 1 ? "document" : "documents"} ready. Add any
                missing documents, then analyze to extract fields and check
                mismatches.
              </p>
              <Link
                href={`/cases/${savedCase.id}`}
                className="inline-flex items-center gap-2 rounded-full border border-[#e5ddd0] bg-white px-4 py-2 text-sm font-bold text-[#5a5046] shadow-sm hover:bg-[#faf8f4]"
              >
                <Folder className="h-4 w-4 text-[#8a7f72]" />
                {savedCase.displayName}
              </Link>
              {notices}
            </div>
            <div className="w-full max-w-3xl rounded-[2rem] border border-[#e5ddd0] bg-white p-6 shadow-sm">
              {rail}
            </div>
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#8a7f72]">
              Mode:{" "}
              {comparisonOptions.considerFormatting
                ? "Strict — consider formatting"
                : "Lenient — ignore formatting"}
            </p>
            <div className="mt-2 flex w-full max-w-3xl flex-col items-center gap-4">
              <DocumentPicker compact disabled={disabled} onFiles={addFiles} />
              <AnalysisModeActions
                disabled={disabled || !uploads.length}
                onSelect={requestAnalysis}
              />
            </div>
          </div>
        </section>
      )}
      <DuplicateUploadDialog
        open={conflicts.length > 0}
        conflicts={conflicts}
        onOpenChange={(open) => {
          if (!open && !busyRef.current) setConflicts([]);
        }}
        onOverwrite={() =>
          void addFiles(
            conflicts.map((item) => item.file),
            "overwrite",
          ).catch(() => {})
        }
        onDuplicate={() =>
          void addFiles(
            conflicts.map((item) => item.file),
            "duplicate",
          ).catch(() => {})
        }
      />
      <AnalysisOptionsDialog
        open={optionsOpen}
        analysisMode={analysisMode}
        onOpenChange={setOptionsOpen}
        onSelect={(options) => void analyze(options)}
      />
    </AppShell>
  );
}
