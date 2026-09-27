import type { processStoredCaseFiles } from "./pipeline";
import { ownDocumentPages } from "./staged-review-contract";
import { MAX_CASE_PAGE_COUNT } from "../../lib/upload-page-limit";
import {
  cachedReviewStage,
  type ReviewCheckpointStore,
} from "./review-checkpoints";

type Extraction = Awaited<ReturnType<typeof processStoredCaseFiles>>;
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// This snapshot is an untrusted first pass, never an approval decision. A
// resumed snapshot still goes through every source and packet review contract.
export function parseExtractionCheckpoint(raw: string): Extraction {
  const value: unknown = JSON.parse(raw);
  if (
    !record(value) ||
    !Array.isArray(value.documents) ||
    !value.documents.length ||
    !Array.isArray(value.reviewPages) ||
    !value.reviewPages.length ||
    !Array.isArray(value.mismatches) ||
    !Array.isArray(value.verificationGroups) ||
    !record(value.summary) ||
    !record(value.comparisonOptions) ||
    !record(value.fieldConfiguration) ||
    !["standard", "smart_split"].includes(String(value.analysisMode))
  )
    throw new Error("Invalid extraction checkpoint structure.");
  const ids = new Set<string>();
  const sourcePages = new Set<string>();
  for (const page of value.reviewPages) {
    if (
      !record(page) ||
      typeof page.sourceFileName !== "string" ||
      !page.sourceFileName ||
      !Number.isInteger(page.pageNumber) ||
      Number(page.pageNumber) < 1 ||
      typeof page.image !== "string" ||
      !page.image.startsWith("data:image/")
    )
      throw new Error("Invalid extraction checkpoint page.");
    const address = JSON.stringify([page.sourceFileName, page.pageNumber]);
    if (sourcePages.has(address))
      throw new Error("Duplicate extraction checkpoint source page.");
    sourcePages.add(address);
  }
  for (const document of value.documents) {
    if (
      !record(document) ||
      typeof document.id !== "string" ||
      !document.id ||
      ids.has(document.id) ||
      typeof document.type !== "string" ||
      typeof document.title !== "string" ||
      typeof document.md !== "string" ||
      !record(document.fields) ||
      typeof document.sourceFileName !== "string" ||
      !Array.isArray(document.sourcePageNumbers) ||
      !document.sourcePageNumbers.length ||
      document.sourcePageNumbers.some(
        (page) => !Number.isInteger(page) || Number(page) < 1,
      ) ||
      (document.lineItems !== undefined &&
        (!Array.isArray(document.lineItems) ||
          document.lineItems.some((item) => !record(item))))
    )
      throw new Error("Invalid extraction checkpoint document.");
    ids.add(document.id);
  }
  const result = value as Extraction;
  if (result.reviewPages.length > MAX_CASE_PAGE_COUNT)
    throw new Error("Extraction checkpoint exceeds the case page limit.");
  for (const document of result.documents)
    ownDocumentPages(document, result.reviewPages);
  return result;
}

export function loadOrExtractCase(options: {
  key: string;
  store: ReviewCheckpointStore;
  extract: () => Promise<Extraction>;
}) {
  return cachedReviewStage({
    key: options.key,
    store: options.store,
    validate: parseExtractionCheckpoint,
    run: async () => {
      const raw = JSON.stringify(await options.extract());
      return { raw, result: parseExtractionCheckpoint(raw) };
    },
  });
}
