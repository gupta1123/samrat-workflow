"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import styles from "./PdfEvidencePreview.module.css";

type PdfEvidencePreviewProps = {
  url: string;
  pageNumber: number;
  zoom: number;
  highlightText?: string | null;
  highlightQueries?: string[];
  highlightLabel?: string | null;
  highlightOccurrence?: number;
  highlightMode?: "text" | "row";
  searchPageStart?: number;
  searchPageEnd?: number;
  onHighlightPageChange?: (pageNumber: number) => void;
  onPageCountChange?: (pageCount: number) => void;
};

type HighlightBox = {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
};

type PositionedPdfTextItem = PdfTextItem & Omit<HighlightBox, "id">;

function normalizeSearchText(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findMatchingItemIndexes(
  items: PdfTextItem[],
  query: string,
  occurrence = 0,
) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return new Set<number>();

  const characters: string[] = [];
  const itemByCharacter: number[] = [];

  const appendCharacter = (character: string, itemIndex: number) => {
    if (character === " " && characters.at(-1) === " ") return;
    characters.push(character);
    itemByCharacter.push(itemIndex);
  };

  items.forEach((item, itemIndex) => {
    const normalizedItem = normalizeSearchText(item.str);
    for (const character of normalizedItem) {
      appendCharacter(character, itemIndex);
    }
    appendCharacter(" ", itemIndex);
  });

  const searchableText = characters.join("").trim();
  const compactCharacters: string[] = [];
  const compactItemByCharacter: number[] = [];
  characters.forEach((character, index) => {
    if (character === " ") return;
    compactCharacters.push(character);
    compactItemByCharacter.push(itemByCharacter[index]);
  });
  const compactSearchableText = compactCharacters.join("");
  // Exact normalized values only: a partial token can produce a convincing but
  // incorrect highlight elsewhere in a dense invoice.
  const candidateQueries = [normalizedQuery];

  const collectMatch = (
    text: string,
    itemMap: number[],
    candidate: string,
    enforceBoundaries: boolean,
  ) => {
    const searchable = enforceBoundaries ? ` ${text} ` : text;
    const needle = enforceBoundaries ? ` ${candidate} ` : candidate;
    let matchStart = -1;
    let searchFrom = 0;

    for (
      let matchIndex = 0;
      matchIndex <= Math.max(0, occurrence);
      matchIndex += 1
    ) {
      matchStart = searchable.indexOf(needle, searchFrom);
      if (matchStart === -1) return new Set<number>();
      searchFrom =
        matchStart + Math.max(1, needle.length - (enforceBoundaries ? 1 : 0));
    }

    const mapStart = enforceBoundaries ? matchStart : matchStart;
    const indexes = new Set<number>();
    for (
      let index = mapStart;
      index < mapStart + candidate.length;
      index += 1
    ) {
      const itemIndex = itemMap[index];
      if (itemIndex !== undefined) indexes.add(itemIndex);
    }
    return indexes;
  };

  for (const candidate of candidateQueries) {
    const spacedMatch = collectMatch(
      searchableText,
      itemByCharacter,
      candidate,
      true,
    );
    if (spacedMatch.size > 0) return spacedMatch;

    const compactCandidate = candidate.replace(/\s+/g, "");
    if (compactCandidate.length >= 4) {
      const compactMatch = collectMatch(
        compactSearchableText,
        compactItemByCharacter,
        compactCandidate,
        false,
      );
      if (compactMatch.size > 0) return compactMatch;
    }
  }

  return new Set<number>();
}

function findMatchingItemIndexesForQueries(
  items: PdfTextItem[],
  queries: string[],
  occurrence = 0,
) {
  for (const query of queries) {
    const matchingIndexes = findMatchingItemIndexes(items, query, occurrence);
    if (matchingIndexes.size > 0) return matchingIndexes;
  }
  return new Set<number>();
}

function readPdfTextItems(items: unknown[]): PdfTextItem[] {
  return items.flatMap((item) => {
    if (!item || typeof item !== "object" || !("str" in item)) return [];
    const record = item as Record<string, unknown>;
    const str = String(record.str ?? "");
    const transform = Array.isArray(record.transform)
      ? record.transform.map(Number)
      : [];
    if (!str.trim() || transform.length < 6) return [];
    return [
      {
        str,
        transform,
        width: Number(record.width) || 0,
        height: Number(record.height) || 0,
      },
    ];
  });
}

export function PdfEvidencePreview({
  url,
  pageNumber,
  zoom,
  highlightText,
  highlightQueries,
  highlightLabel,
  highlightOccurrence = 0,
  highlightMode = "text",
  searchPageStart,
  searchPageEnd,
  onHighlightPageChange,
  onPageCountChange,
}: PdfEvidencePreviewProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const panStateRef = useRef<{
    pointerId: number;
    pointerX: number;
    pointerY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const pdfDocumentRef = useRef<{
    numPages: number;
    getPage: (
      page: number,
    ) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>;
  } | null>(null);
  const [availableSize, setAvailableSize] = useState({ width: 0, height: 0 });
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [positionedTextItems, setPositionedTextItems] = useState<
    PositionedPdfTextItem[]
  >([]);
  const [renderState, setRenderState] = useState<
    "loading" | "ready" | "fallback"
  >("loading");
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isSearchingPages, setIsSearchingPages] = useState(false);
  const [isPanning, setIsPanning] = useState(false);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;

    const updateSize = () =>
      setAvailableSize({
        width: element.clientWidth,
        height: element.clientHeight,
      });
    updateSize();

    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const effectiveHighlightQueries = useMemo(
    () =>
      Array.from(
        new Set(
          [...(highlightQueries ?? []), highlightText ?? ""]
            .map((query) => query.trim())
            .filter(Boolean),
        ),
      ),
    [highlightQueries, highlightText],
  );
  const normalizedHighlight = useMemo(
    () =>
      effectiveHighlightQueries.some((query) =>
        Boolean(normalizeSearchText(query)),
      ),
    [effectiveHighlightQueries],
  );
  const matchedTextBoxes = useMemo(() => {
    const matchingIndexes = findMatchingItemIndexesForQueries(
      positionedTextItems,
      effectiveHighlightQueries,
      highlightOccurrence,
    );
    return positionedTextItems.flatMap((item, itemIndex): HighlightBox[] =>
      matchingIndexes.has(itemIndex)
        ? [
            {
              id: `text-item-${itemIndex}`,
              left: item.left,
              top: item.top,
              width: item.width,
              height: item.height,
            },
          ]
        : [],
    );
  }, [effectiveHighlightQueries, highlightOccurrence, positionedTextItems]);
  const highlightBoxes = useMemo(() => {
    if (
      highlightMode !== "row" ||
      matchedTextBoxes.length === 0 ||
      pageSize.width <= 0
    ) {
      return matchedTextBoxes;
    }

    const top = Math.max(
      0,
      Math.min(...matchedTextBoxes.map((box) => box.top)) - 3,
    );
    const bottom =
      Math.max(...matchedTextBoxes.map((box) => box.top + box.height)) + 3;
    const pageInset = Math.max(10, pageSize.width * 0.045);
    return [
      {
        id: "evidence-row",
        left: pageInset,
        top,
        width: Math.max(24, pageSize.width - pageInset * 2),
        height: Math.max(18, bottom - top),
      },
    ];
  }, [highlightMode, matchedTextBoxes, pageSize.width]);

  useEffect(() => {
    if (!url || availableSize.width <= 0 || availableSize.height <= 0) return;

    let cancelled = false;
    let loadingTask: { destroy?: () => Promise<void> | void } | null = null;
    let renderTask: { cancel?: () => void; promise: Promise<void> } | null =
      null;

    setRenderState("loading");
    setRenderError(null);
    setPositionedTextItems([]);

    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        if (!pdfjs.GlobalWorkerOptions.workerSrc) {
          pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
        }

        const nextLoadingTask = pdfjs.getDocument({ url });
        loadingTask = nextLoadingTask;
        const pdf = await nextLoadingTask.promise;
        if (cancelled) return;
        pdfDocumentRef.current = pdf;

        onPageCountChange?.(pdf.numPages);
        const safePageNumber = Math.min(Math.max(1, pageNumber), pdf.numPages);
        const page = await pdf.getPage(safePageNumber);
        const baseViewport = page.getViewport({ scale: 1 });
        const widthScale = (availableSize.width - 36) / baseViewport.width;
        const heightScale = (availableSize.height - 36) / baseViewport.height;
        const comfortableHeightScale = heightScale * 1.4;
        const fitScale = Math.max(
          0.25,
          Math.min(widthScale, comfortableHeightScale),
        );
        const viewport = page.getViewport({ scale: fitScale * zoom });
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context)
          throw new Error("Unable to create the PDF preview canvas.");

        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        setPageSize({ width: viewport.width, height: viewport.height });

        const nextRenderTask = page.render({
          canvasContext: context,
          viewport,
          transform:
            outputScale === 1
              ? undefined
              : [outputScale, 0, 0, outputScale, 0, 0],
        });
        renderTask = nextRenderTask;

        const [textContent] = await Promise.all([
          page.getTextContent(),
          nextRenderTask.promise,
        ]);
        if (cancelled) return;

        const textItems = readPdfTextItems(textContent.items);
        const positionedItems = textItems.map((item): PositionedPdfTextItem => {
          const transform = pdfjs.Util.transform(
            viewport.transform,
            item.transform,
          );
          const fontHeight = Math.max(
            8,
            Math.hypot(transform[2], transform[3]),
          );
          const width = Math.max(fontHeight * 0.6, item.width * viewport.scale);
          return {
            ...item,
            left: Math.max(0, transform[4] - 3),
            top: Math.max(0, transform[5] - fontHeight - 2),
            width: width + 6,
            height: fontHeight + 4,
          };
        });

        setPositionedTextItems(positionedItems);
        setRenderState("ready");
      } catch (error) {
        if (
          cancelled ||
          (error instanceof Error &&
            error.name === "RenderingCancelledException")
        )
          return;
        setRenderError(
          error instanceof Error
            ? error.message
            : "Interactive PDF preview unavailable.",
        );
        setRenderState("fallback");
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel?.();
      pdfDocumentRef.current = null;
      void loadingTask?.destroy?.();
    };
  }, [availableSize, onPageCountChange, pageNumber, url, zoom]);

  useEffect(() => {
    if (
      renderState !== "ready" ||
      !normalizedHighlight ||
      highlightBoxes.length > 0 ||
      !pdfDocumentRef.current ||
      !searchPageStart ||
      !searchPageEnd
    ) {
      setIsSearchingPages(false);
      return;
    }

    let cancelled = false;
    const pdf = pdfDocumentRef.current;
    const firstPage = Math.min(Math.max(1, searchPageStart), pdf.numPages);
    const lastPage = Math.min(Math.max(firstPage, searchPageEnd), pdf.numPages);
    const candidatePages = Array.from(
      { length: lastPage - firstPage + 1 },
      (_, index) => firstPage + index,
    ).filter((candidatePage) => candidatePage !== pageNumber);

    if (candidatePages.length === 0) {
      setIsSearchingPages(false);
      return;
    }

    setIsSearchingPages(true);
    void (async () => {
      try {
        for (const candidatePage of candidatePages) {
          const page = await pdf.getPage(candidatePage);
          const textContent = await page.getTextContent();
          const items = readPdfTextItems(textContent.items);
          const matchingIndexes = findMatchingItemIndexesForQueries(
            items,
            effectiveHighlightQueries,
            highlightOccurrence,
          );
          if (cancelled) return;
          if (matchingIndexes.size > 0) {
            onHighlightPageChange?.(candidatePage);
            return;
          }
        }
      } finally {
        if (!cancelled) setIsSearchingPages(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    highlightBoxes.length,
    highlightOccurrence,
    effectiveHighlightQueries,
    normalizedHighlight,
    onHighlightPageChange,
    pageNumber,
    renderState,
    searchPageEnd,
    searchPageStart,
  ]);

  useEffect(() => {
    if (highlightBoxes.length === 0) return;
    const timer = window.setTimeout(() => {
      const scroller = scrollerRef.current;
      const focusSelector =
        matchedTextBoxes.length > 0
          ? "[data-pdf-focus]"
          : `[data-pdf-highlight="${highlightBoxes[0].id}"]`;
      scroller
        ?.querySelector<HTMLElement>(focusSelector)
        ?.scrollIntoView({
          behavior: "smooth",
          block: "center",
          inline: "center",
        });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [highlightBoxes, matchedTextBoxes]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    if (
      !scroller ||
      zoom <= 1 ||
      event.pointerType === "touch" ||
      event.button !== 0
    )
      return;
    event.preventDefault();
    panStateRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      scrollLeft: scroller.scrollLeft,
      scrollTop: scroller.scrollTop,
    };
    scroller.setPointerCapture(event.pointerId);
    setIsPanning(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    const panState = panStateRef.current;
    if (!scroller || !panState || panState.pointerId !== event.pointerId)
      return;
    scroller.scrollLeft =
      panState.scrollLeft - (event.clientX - panState.pointerX);
    scroller.scrollTop =
      panState.scrollTop - (event.clientY - panState.pointerY);
  };

  const stopPanning = (event: ReactPointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    const panState = panStateRef.current;
    if (!scroller || !panState || panState.pointerId !== event.pointerId)
      return;
    if (scroller.hasPointerCapture(event.pointerId))
      scroller.releasePointerCapture(event.pointerId);
    panStateRef.current = null;
    setIsPanning(false);
  };

  return (
    <div
      ref={scrollerRef}
      className={`${styles.scroller} ${zoom > 1 ? styles.pannable : ""} ${isPanning ? styles.panning : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopPanning}
      onPointerCancel={stopPanning}
    >
      {renderState === "fallback" ? (
        <>
          <iframe
            src={`${url}#page=${pageNumber}&toolbar=0&navpanes=0`}
            className={styles.fallbackFrame}
            title="Document preview"
          />
          <div
            className={styles.fallbackNotice}
            title={renderError || undefined}
          >
            Interactive highlighting is unavailable for this PDF. Native preview
            shown.
          </div>
        </>
      ) : (
        <div
          className={`${styles.stage} ${zoom > 1 ? styles.stageZoomed : ""}`}
        >
          <div
            className={styles.page}
            style={{
              width: pageSize.width || undefined,
              height: pageSize.height || undefined,
            }}
          >
            <canvas ref={canvasRef} className={styles.canvas} />
            {matchedTextBoxes[0] ? (
              <span
                data-pdf-focus
                className={styles.focusAnchor}
                style={{
                  left: matchedTextBoxes[0].left,
                  top: matchedTextBoxes[0].top,
                  width: matchedTextBoxes[0].width,
                  height: matchedTextBoxes[0].height,
                }}
                aria-hidden="true"
              />
            ) : null}
            {highlightBoxes.map((box) => (
              <span
                key={box.id}
                data-pdf-highlight={box.id}
                className={`${styles.highlight} ${highlightMode === "row" ? styles.highlightRow : ""}`}
                style={{
                  left: box.left,
                  top: box.top,
                  width: box.width,
                  height: box.height,
                }}
                aria-label={
                  highlightLabel
                    ? `Highlighted ${highlightLabel}`
                    : "Highlighted PDF evidence"
                }
              />
            ))}
          </div>
        </div>
      )}

      {renderState === "loading" ? (
        <div className={styles.loading}>
          {normalizedHighlight ? "Locating mismatch…" : "Rendering PDF…"}
        </div>
      ) : null}
      {renderState === "ready" &&
      normalizedHighlight &&
      highlightBoxes.length === 0 &&
      !isSearchingPages ? (
        <div className={styles.noMatch}>
          {positionedTextItems.length === 0
            ? "This scanned page has no selectable text, so automatic highlighting is unavailable."
            : `Automatic highlighting could not locate ${highlightLabel ? highlightLabel.toLowerCase() : "the selected source value"} on this page.`}
        </div>
      ) : null}
    </div>
  );
}
