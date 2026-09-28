"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

/** Render locally rather than relying on a browser PDF plugin (unavailable in some webviews). */
export function PdfDocumentPreview({
  url,
  title,
  initialPage = 1,
  className = "",
}: {
  url: string;
  title: string;
  initialPage?: number;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(initialPage);
  const [width, setWidth] = useState(600);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let destroy: (() => Promise<void>) | undefined;
    setPdf(null);
    setError("");
    setLoading(true);
    void (async () => {
      const pdfjs = await import("pdfjs-dist");
      if (!active) return;
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
      const task = pdfjs.getDocument({ url, isEvalSupported: false });
      destroy = () => task.destroy();
      const document = await task.promise;
      if (active) {
        setPage(Math.min(document.numPages, Math.max(1, initialPage)));
        setPdf(document);
      }
    })().catch(() => {
      if (active) {
        setError(
          "This PDF could not be previewed. Open the original document to inspect it.",
        );
        setLoading(false);
      }
    });
    return () => {
      active = false;
      void destroy?.().catch(() => {});
    };
  }, [url, initialPage]);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(entries[0].contentRect.width),
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let active = true;
    let task: RenderTask | undefined;
    setLoading(true);
    setError("");
    void (async () => {
      const pdfPage = await pdf.getPage(page);
      if (!active || !canvas.current) return;
      const base = pdfPage.getViewport({ scale: 1, rotation });
      const scale =
        Math.min(Math.max(160, width - 32) / base.width, 1.5) * zoom;
      const viewport = pdfPage.getViewport({ scale, rotation });
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(8_000_000 / (viewport.width * viewport.height)),
      );
      const context = canvas.current.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      canvas.current.width = Math.floor(viewport.width * ratio);
      canvas.current.height = Math.floor(viewport.height * ratio);
      canvas.current.style.width = `${viewport.width}px`;
      canvas.current.style.height = `${viewport.height}px`;
      task = pdfPage.render({
        canvasContext: context,
        viewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
      });
      await task.promise;
      if (active) setLoading(false);
    })().catch((error) => {
      if (active && error?.name !== "RenderingCancelledException") {
        setError(
          "Could not display this page. Open the original document below.",
        );
        setLoading(false);
      }
    });
    return () => {
      active = false;
      task?.cancel();
    };
  }, [pdf, page, width, zoom, rotation]);
  const control =
    "rounded-lg p-2 text-white hover:bg-white/20 disabled:opacity-40";
  return (
    <div
      ref={container}
      className={`relative flex min-h-0 flex-col overflow-hidden rounded-xl bg-slate-800 ${className}`}
    >
      <div className="min-h-0 flex-1 overflow-auto p-4 pb-6">
        {loading && (
          <p
            role="status"
            className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-slate-900/90 px-3 py-2 text-xs text-white"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading PDF…
          </p>
        )}
        {error ? (
          <div
            role="alert"
            className="mx-auto mt-8 max-w-md p-5 text-center text-sm text-white"
          >
            {error}
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="mt-3 block underline"
            >
              Open original document
            </a>
          </div>
        ) : (
          <canvas
            ref={canvas}
            role="img"
            aria-label={`${title}, page ${page}`}
            className="mx-auto block bg-white shadow-xl"
          />
        )}
      </div>
      <div
        className="flex shrink-0 flex-wrap items-center justify-center gap-1 border-t border-white/10 bg-slate-900 px-2 py-1 text-xs text-white"
        role="group"
        aria-label="PDF preview controls"
      >
        <button
          className={control}
          aria-label="Previous PDF page"
          disabled={!pdf || page <= 1}
          onClick={() => setPage((value) => value - 1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span aria-live="polite" className="min-w-16 text-center">
          {pdf ? `Page ${page} / ${pdf.numPages}` : "PDF"}
        </span>
        <button
          className={control}
          aria-label="Next PDF page"
          disabled={!pdf || page >= pdf.numPages}
          onClick={() => setPage((value) => value + 1)}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <button
          className={control}
          aria-label="Zoom PDF out"
          disabled={!pdf || zoom <= 0.5}
          onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          className={control}
          aria-label="Zoom PDF in"
          disabled={!pdf || zoom >= 3}
          onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          className={control}
          aria-label="Rotate PDF"
          disabled={!pdf}
          onClick={() => setRotation((value) => (value + 90) % 360)}
        >
          <RotateCw className="h-4 w-4" />
        </button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="ml-2 p-2 text-xs underline"
        >
          Open original
        </a>
      </div>
    </div>
  );
}
