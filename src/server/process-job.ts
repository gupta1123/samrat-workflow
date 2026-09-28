import { randomUUID } from "node:crypto";
import type {
  CaseAnalysisMode,
  CaseDoc,
  FieldKey,
  Mismatch,
} from "../types/pipeline";
import {
  areComparableValuesEqual,
  DEFAULT_COMPARISON_OPTIONS,
  getComparableFieldValue,
} from "./comparison";
import { FIELD_DEFINITIONS } from "./document-schema";
import {
  getMissingCorePacketDocumentGroups,
  selectCaseSummaryDocuments,
  summarizeCase,
} from "./case-summary";
import { buildMissingDocumentIssues } from "../lib/missing-documents";
import {
  getPersistedPacketFieldConfiguration,
  invalidateFieldSettings,
} from "./field-settings-service";
import { serializeFieldsWithLineItems } from "./line-items";
import { mergePersistedStructuredData } from "./persisted-structured-data";
import {
  remainingTimeout,
  withProcessingDeadline,
} from "./processing/deadline";
import {
  buildAuthoritativeTermsComplianceResult,
  enrichProcessedDocuments,
  processStoredCaseFiles,
  verifyWeightCalculationIntegrity,
} from "./processing/pipeline";
import { createSupabaseAdminClient } from "./supabase/admin";
import { TERMS_COMPLIANCE_MISMATCH_MODE } from "./terms-compliance";
import { buildAnalysisIntegrityRecord } from "../lib/analysis-integrity";
import { composeAuthoritativeCaseDisplayName } from "./case-naming";
import { ReviewContractError } from "./processing/review-contract-error";
import {
  OpenRouterOutputLimitError,
  OpenRouterResponseError,
} from "./processing/openrouter";
import {
  buildInvoiceNumberRequiredIssues,
  consolidateInvoiceNumberIssues,
} from "../lib/invoice-approval";
import {
  buildCollapsedDuplicateInvoiceIssues,
  buildCrossCaseDuplicateInvoiceIssues,
  buildDuplicateInvoiceIssues,
  type DuplicateInvoiceSiblingCase,
} from "../lib/duplicate-invoice";
import { reviewExtractedDocumentsInStages } from "./processing/staged-review";
import {
  createReviewCheckpointStore,
  reviewCheckpointKey,
  reviewInputDigest,
} from "./processing/review-checkpoints";
import { loadOrExtractCase } from "./processing/extraction-checkpoint";

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
function message(e: unknown) {
  return e instanceof Error
    ? e.message
    : String(e ?? "Unknown processing error");
}
export function isTerminalProcessingError(e: unknown) {
  if (
    e instanceof OpenRouterResponseError &&
    e.status >= 400 &&
    e.status < 500 &&
    e.status !== 429
  )
    return true;
  // A bounded review repair has already been tried. Re-extraction is not a
  // transport retry and cannot repair an invalid semantic response contract.
  if (
    e instanceof ReviewContractError ||
    e instanceof OpenRouterOutputLimitError
  )
    return true;
  return /no files|file limit|page limit|unsupported|invalid|too large|not configured|no documents|quota|credits|billing/i.test(
    message(e),
  );
}

async function withReviewHeartbeat<T>(
  update: (progress: number, stage: string) => Promise<void>,
  work: (
    reportStage: (progress: number, stage: string) => Promise<void>,
  ) => Promise<T>,
) {
  let progress = 84;
  let stage = "AI reviewer checking packet evidence";
  let inFlight: Promise<void> | null = null;
  const reportStage = async (nextProgress: number, nextStage: string) => {
    await inFlight;
    progress = Math.max(progress, Math.min(97, nextProgress));
    stage = nextStage;
    await update(progress, stage);
  };
  const timer = setInterval(() => {
    if (inFlight) return;
    const heartbeat = update(progress, stage)
      .catch((error) => {
        console.warn("Unable to update review progress", message(error));
      })
      .finally(() => {
        if (inFlight === heartbeat) inFlight = null;
      });
    inFlight = heartbeat;
  }, 20_000);

  try {
    return await work(reportStage);
  } finally {
    clearInterval(timer);
    await inFlight;
  }
}
function filterIssues(issues: Mismatch[], docs: CaseDoc[]) {
  const ids = new Set(docs.map((d) => d.id));
  return issues.filter(
    (m) =>
      !m.values?.length || m.values.some((v) => v.docId && ids.has(v.docId)),
  );
}

function issueEvidenceKeys(issue: Mismatch) {
  return new Set(
    (issue.values ?? []).map(
      (entry) =>
        `${entry.docId}:${String(entry.value ?? "")
          .toLocaleLowerCase("en-IN")
          .replace(/[^a-z0-9]/g, "")}`,
    ),
  );
}

function issueDocumentIds(issue: Mismatch) {
  return new Set(
    (issue.values ?? [])
      .map((entry) => entry.docId)
      .filter((docId): docId is string => Boolean(docId)),
  );
}

function isExtractionReviewIssue(issue: Mismatch) {
  return /^(?:quality|evidence)-review-/.test(issue.id);
}

function mergeUniqueIssues(...groups: Mismatch[][]) {
  const merged: Mismatch[] = [];
  for (const issue of groups.flat()) {
    const evidence = issueEvidenceKeys(issue);
    const duplicate = merged.some((candidate) => {
      if (candidate.field !== issue.field) return false;
      const candidateEvidence = issueEvidenceKeys(candidate);
      if ([...evidence].some((key) => candidateEvidence.has(key))) return true;

      if (
        !isExtractionReviewIssue(candidate) &&
        !isExtractionReviewIssue(issue)
      ) {
        return false;
      }
      const candidateDocumentIds = issueDocumentIds(candidate);
      return [...issueDocumentIds(issue)].some((docId) =>
        candidateDocumentIds.has(docId),
      );
    });
    if (!duplicate) merged.push(issue);
  }
  return merged;
}

function canonicalLiteralEvidence(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-IN");
}

export function enforceMismatchEvidenceIntegrity(issues: Mismatch[]) {
  return issues.filter((issue) => {
    const evidence = (issue.values ?? []).filter(
      (entry) => entry.docId && String(entry.value ?? "").trim(),
    );
    const documentIds = new Set(evidence.map((entry) => entry.docId));
    if (documentIds.size < 2) return true;
    return (
      new Set(evidence.map((entry) => canonicalLiteralEvidence(entry.value)))
        .size > 1
    );
  });
}

const CANONICAL_FIELD_KEYS = new Set(
  FIELD_DEFINITIONS.map((definition) => definition.key),
);

export function reconcileMismatchesWithReviewedDocuments(
  issues: Mismatch[],
  documents: CaseDoc[],
) {
  const documentsById = new Map(
    documents.map((document) => [document.id, document]),
  );

  return issues.flatMap((issue) => {
    if (!CANONICAL_FIELD_KEYS.has(issue.field as FieldKey)) return [issue];

    const citedDocumentIds = [
      ...new Set(
        (issue.values ?? [])
          .map((entry) => entry.docId)
          .filter((docId): docId is string => Boolean(docId)),
      ),
    ];
    // Single-document warnings do not represent a cross-document value
    // comparison and must remain untouched.
    if (citedDocumentIds.length < 2) return [issue];

    const field = issue.field as FieldKey;
    const reviewedValues = citedDocumentIds.flatMap((docId) => {
      const document = documentsById.get(docId);
      if (!document) return [];
      const value = getComparableFieldValue(document, field);
      if (value === null || value === undefined || !String(value).trim()) {
        return [];
      }
      const previous = issue.values?.find((entry) => entry.docId === docId);
      return [
        {
          docId,
          value,
          ...(previous?.sourceFileName
            ? { sourceFileName: previous.sourceFileName }
            : {}),
          ...(previous?.pageNumber ? { pageNumber: previous.pageNumber } : {}),
          ...(typeof previous?.isOutlier === "boolean"
            ? { isOutlier: previous.isOutlier }
            : {}),
        },
      ];
    });
    if (reviewedValues.length < 2) return [];

    const first = reviewedValues[0].value;
    const stillConflicts = reviewedValues
      .slice(1)
      .some(
        (entry) =>
          !areComparableValuesEqual(
            first,
            entry.value,
            DEFAULT_COMPARISON_OPTIONS,
            field,
          ),
      );
    return stillConflicts ? [{ ...issue, values: reviewedValues }] : [];
  });
}

export function processCaseJob(jobId: string) {
  return withProcessingDeadline(() => processJob(jobId));
}
async function processJob(jobId: string) {
  const performanceStartedAt = Date.now();
  const phases: Record<string, number> = {};
  const measure = async <T>(name: string, work: () => Promise<T>) => {
    const startedAt = Date.now();
    try {
      return await work();
    } finally {
      phases[name] = (phases[name] ?? 0) + (Date.now() - startedAt);
    }
  };
  invalidateFieldSettings();
  const db = createSupabaseAdminClient();
  const worker = `netlify-${randomUUID()}`;
  const claimed = await db.rpc("claim_case_job", {
    p_job: jobId,
    p_worker: worker,
  });
  if (claimed.error) throw claimed.error;
  if (!claimed.data) return { skipped: true };
  const job = claimed.data as {
    id: string;
    case_id: string;
    result: unknown;
    created_at?: string;
  };
  const update = async (progress: number, stage: string) => {
    remainingTimeout();
    const result = await db
      .from("packet_processing_jobs")
      .update({ progress, stage, locked_at: new Date().toISOString() })
      .eq("id", jobId)
      .eq("status", "running")
      .eq("locked_by", worker)
      .select("id")
      .maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) throw new Error("Processing lease was superseded.");
  };
  const assertLease = async () => {
    remainingTimeout();
    const result = await db
      .from("packet_processing_jobs")
      .select("id")
      .eq("id", jobId)
      .eq("status", "running")
      .eq("locked_by", worker)
      .maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) throw new Error("Processing lease was superseded.");
  };
  const checkpoints = createReviewCheckpointStore(db, job.case_id, assertLease);
  const readManifest = async () => {
    const result = await db
      .from("packet_case_files")
      .select(
        "id,original_name,storage_bucket,storage_path,mime_type,content_sha256",
      )
      .eq("case_id", job.case_id)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (result.error) throw result.error;
    if (!result.data?.length) throw new Error("No files found for this case.");
    return result.data;
  };
  let leaseHeartbeatInFlight: Promise<void> | null = null;
  const leaseHeartbeat = setInterval(() => {
    if (leaseHeartbeatInFlight) return;
    try {
      remainingTimeout();
    } catch {
      clearInterval(leaseHeartbeat);
      return;
    }
    const heartbeat = (async () => {
      const { error } = await db
        .from("packet_processing_jobs")
        .update({ locked_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("status", "running")
        .eq("locked_by", worker);
      if (error) throw error;
    })()
      .catch((error) => {
        console.warn("Unable to refresh processing lease", message(error));
      })
      .finally(() => {
        if (leaseHeartbeatInFlight === heartbeat) leaseHeartbeatInFlight = null;
      });
    leaseHeartbeatInFlight = heartbeat;
  }, 15_000);
  try {
    const options = record(job.result);
    const mode: CaseAnalysisMode =
      options.analysisMode === "smart_split" ? "smart_split" : "standard";
    const [config, current] = await measure("loadConfigurationMs", async () =>
      Promise.all([
        getPersistedPacketFieldConfiguration(),
        db
          .from("packet_documents")
          .select(
            "client_document_id,source_file_name,source_hint,document_type,title,extracted_fields",
          )
          .eq("case_id", job.case_id),
      ]),
    );
    if (current.error) throw current.error;
    const manifest = await readManifest();
    const manifestDigest = reviewInputDigest(manifest);
    const extractionKey = reviewCheckpointKey("extraction", {
      manifest,
      fieldConfiguration: config,
      mode,
      comparisonOptions: options.comparisonOptions,
      model:
        process.env.OPENROUTER_MODEL ||
        process.env.NEXT_PUBLIC_OPENROUTER_MODEL ||
        "google/gemini-2.5-flash",
    });
    const extraction = await measure("extractAndCompareMs", () =>
      loadOrExtractCase({
        key: extractionKey,
        store: checkpoints.store,
        extract: () =>
          processStoredCaseFiles({
            caseId: job.case_id,
            analysisMode: mode,
            comparisonOptions: options.comparisonOptions,
            onProgress: async (p) => update(p.progress, p.stage),
          }),
      }),
    );
    const processed = extraction.result;
    if (extraction.reused)
      await update(83, "Resumed extraction; verifying saved source work");
    let documents = enrichProcessedDocuments(
      mergePersistedStructuredData(
        processed.documents,
        current.data || [],
        config,
      ),
    );
    const reviewed = await measure("extractionReviewMs", () =>
      withReviewHeartbeat(update, (reportReviewStage) =>
        reviewExtractedDocumentsInStages(documents, {
          sourcePages: processed.reviewPages,
          comparisonOptions: processed.comparisonOptions,
          checkpoints: checkpoints.store,
          onReviewStage: reportReviewStage,
        }),
      ),
    );
    documents = reviewed.documents;
    const authoritative = reviewed.authoritativeReview;
    if (!authoritative) {
      throw new Error(
        "Required authoritative packet review did not return a final decision.",
      );
    }
    if (
      !documents.some((d) =>
        Object.values(d.fields).some((v) => typeof v === "string" && v.trim()),
      )
    )
      throw new Error(
        "No documents could be extracted. Check the files and retry with a clearer copy.",
      );
    const reconciledAuthoritativeMismatches =
      reconcileMismatchesWithReviewedDocuments(
        authoritative.mismatches,
        documents,
      );
    const removedStaleMismatchCount =
      authoritative.mismatches.length -
      reconciledAuthoritativeMismatches.length;
    if (removedStaleMismatchCount > 0) {
      reviewed.review.confirmedMismatchCount =
        reconciledAuthoritativeMismatches.length;
      reviewed.review.dismissedMismatchCount =
        (reviewed.review.dismissedMismatchCount ?? 0) +
        removedStaleMismatchCount;
      reviewed.review.warnings.push(
        `Removed ${removedStaleMismatchCount} stale candidate mismatch${removedStaleMismatchCount === 1 ? "" : "es"} after applying the reviewer’s source-backed corrections.`,
      );
    }
    const documentsById = new Map(documents.map((doc) => [doc.id, doc]));
    const reviewedGroups = authoritative.verificationGroups;
    const rawGroups =
      mode === "smart_split" && reviewedGroups.length > 1
        ? reviewedGroups.map((group) => ({
            docs: group.documentIds.map((id) => documentsById.get(id)!),
            sourceFileNames: group.sourceFileNames,
            verificationGroups: [group],
          }))
        : [
            {
              docs: documents,
              sourceFileNames: Array.from(
                new Set(
                  documents
                    .map((d) => d.sourceFileName || d.sourceHint)
                    .filter((x): x is string => Boolean(x)),
                ),
              ),
              verificationGroups: reviewedGroups,
            },
          ];
    // Sibling cases sharing an invoice number: one fetch per job, matched
    // per group below. A second live case with the same vendor invoice
    // number means this packet would book the payable twice.
    let siblingInvoiceCases: DuplicateInvoiceSiblingCase[] = [];
    try {
      const ownerRow = await db
        .from("packet_cases")
        .select("owner_user_id")
        .eq("id", job.case_id)
        .maybeSingle();
      if (!ownerRow.error && ownerRow.data?.owner_user_id) {
        const siblings = await db
          .from("packet_cases")
          .select("id,display_name,status,invoice_number")
          .eq("owner_user_id", ownerRow.data.owner_user_id)
          .neq("id", job.case_id)
          .is("deleted_at", null)
          .not("invoice_number", "is", null)
          .in("status", ["processing", "completed", "accepted"]);
        if (!siblings.error && Array.isArray(siblings.data)) {
          siblingInvoiceCases = siblings.data.map((entry) => ({
            id: String(entry.id),
            displayName: String(entry.display_name ?? ""),
            status: String(entry.status ?? ""),
            invoiceNumber: entry.invoice_number,
          }));
        }
      }
    } catch {
      // Sibling lookup is advisory; the within-case check below still runs.
    }
    const prepared: Array<{
      id: string;
      sourceFileNames: string[];
      documents: Array<Record<string, unknown>>;
      mismatches: Mismatch[];
      summary: ReturnType<typeof summarizeCase>;
      displayName: string;
      meta: Record<string, unknown>;
    }> = [];
    for (let i = 0; i < rawGroups.length; i++) {
      const x = rawGroups[i];
      const groupDocumentIds = new Set(x.docs.map((document) => document.id));
      const groupPageQuality = reviewed.pageQuality.filter((assessment) =>
        groupDocumentIds.has(assessment.documentId),
      );
      const groupDocumentAudits = authoritative.documentAudits.filter((audit) =>
        groupDocumentIds.has(audit.docId),
      );
      const groupTermsChecklist = authoritative.termsChecklist.filter((item) =>
        x.docs.some((doc) => doc.id === item.sourceDocId),
      );
      const terms = buildAuthoritativeTermsComplianceResult(
        x.docs,
        groupTermsChecklist,
      );
      const missingDocumentGroups = getMissingCorePacketDocumentGroups(
        x.docs,
        config,
      );
      const summaryDocuments = selectCaseSummaryDocuments(
        x.docs,
        x.verificationGroups,
      );
      const authoritativeSummary =
        x.verificationGroups.length === 1
          ? x.verificationGroups[0].caseSummary
          : null;
      const requiredInvoiceIssues = buildInvoiceNumberRequiredIssues({
        invoiceNumber:
          authoritativeSummary?.invoiceNumber ??
          summaryDocuments.find(
            (document) =>
              document.type === "Invoice" || document.type === "Tax Invoice",
          )?.fields.invoiceNumber,
        documents: x.docs.map((document) => ({
          id: document.id,
          documentType: document.type,
          invoiceNumber: document.fields.invoiceNumber,
        })),
        verificationGroups: x.verificationGroups,
      });
      const duplicateInvoiceIssues = [
        ...buildCollapsedDuplicateInvoiceIssues({
          documents: x.docs.map((document) => ({
            id: document.id,
            documentType: document.type,
            invoiceNumber: document.fields.invoiceNumber,
            collapsedDuplicateSources: document.collapsedDuplicateSources,
          })),
        }),
        ...buildDuplicateInvoiceIssues({
          documents: x.docs.map((document) => ({
            id: document.id,
            documentType: document.type,
            invoiceNumber: document.fields.invoiceNumber,
            sourceFileName: document.sourceFileName,
            title: document.title,
          })),
          verificationGroups: x.verificationGroups,
        }),
        ...buildCrossCaseDuplicateInvoiceIssues({
          invoiceNumber:
            authoritativeSummary?.invoiceNumber ?? summaryDocuments.find(
              (document) =>
                document.type === "Invoice" || document.type === "Tax Invoice",
            )?.fields.invoiceNumber,
          // Split groups get fresh ids below, so only the saved case id
          // needs self-exclusion here.
          currentCaseId: job.case_id,
          siblings: siblingInvoiceCases,
        }),
      ];
      const mergedMismatches = consolidateInvoiceNumberIssues(
        mergeUniqueIssues(
          filterIssues(reconciledAuthoritativeMismatches, x.docs),
          filterIssues(reviewed.reviewIssues, x.docs),
          filterIssues(terms.mismatches, x.docs),
          buildMissingDocumentIssues(missingDocumentGroups),
          verifyWeightCalculationIntegrity(x.docs),
          duplicateInvoiceIssues,
        ),
        requiredInvoiceIssues,
      );
      const mismatches = enforceMismatchEvidenceIntegrity(mergedMismatches);
      const discardedContradictions =
        mergedMismatches.length - mismatches.length;
      if (discardedContradictions > 0) {
        reviewed.review.warnings.push(
          `Discarded ${discardedContradictions} internally contradictory review issue${discardedContradictions === 1 ? "" : "s"} before saving the case.`,
        );
      }
      const derivedSummary = summarizeCase(
        summaryDocuments,
        mismatches,
        config,
      );
      const authoritativeDisplayName = authoritativeSummary
        ? composeAuthoritativeCaseDisplayName({
            counterpartyName: authoritativeSummary.counterpartyName,
            primaryReference: authoritativeSummary.primaryReference,
            fallback: "Case",
          })
        : derivedSummary.displayName;
      const summary = authoritativeSummary
        ? {
            ...derivedSummary,
            displayName: authoritativeDisplayName,
            buyerName: authoritativeSummary.counterpartyName,
            category: authoritativeSummary.counterpartyName
              ? `${authoritativeSummary.counterpartyName} packet`
              : authoritativeSummary.packetCategory,
            packetCategory: authoritativeSummary.packetCategory,
            poNumber: authoritativeSummary.poNumber,
            invoiceNumber: authoritativeSummary.invoiceNumber,
            primaryReference: authoritativeSummary.primaryReference,
          }
        : derivedSummary;
      const displayName =
        x.verificationGroups.length === 1
          ? authoritativeDisplayName
          : summary.displayName;
      prepared.push({
        id: i === 0 ? job.case_id : randomUUID(),
        sourceFileNames: x.sourceFileNames,
        documents: x.docs.map((d) => ({
          ...d,
          fields: serializeFieldsWithLineItems(d),
        })),
        mismatches,
        summary,
        displayName,
        meta: {
          caseCategory: summary.category,
          packetCategory: summary.packetCategory,
          documentTypes: summary.documentTypes,
          missingDocumentGroups,
          paymentGap: summary.paymentGap,
          analysisMode: mode,
          comparisonOptions: processed.comparisonOptions,
          verificationGroups: x.verificationGroups,
          termsComplianceChecklist: terms.checklist,
          termsComplianceMismatchMode: TERMS_COMPLIANCE_MISMATCH_MODE,
          extractionReview: reviewed.review,
          documentPageQuality: groupPageQuality,
          analysisIntegrity: buildAnalysisIntegrityRecord({
            documentIds: x.docs.map((document) => document.id),
            documentAudits: groupDocumentAudits,
            pageQuality: groupPageQuality,
          }),
          splitAnalysis:
            rawGroups.length > 1
              ? {
                  groupCount: rawGroups.length,
                  index: i + 1,
                  sourceCaseId: job.case_id,
                }
              : null,
        },
      });
    }
    for (let i = 0; i < prepared.length; i++)
      if (prepared.length > 1) {
        const g = prepared[i];
        Object.assign(g.meta, {
          splitAnalysis: {
            groupCount: prepared.length,
            groupIndex: i + 1,
            sourceCaseId: job.case_id,
            sourceFileNames: g.sourceFileNames,
            groupId: g.id,
            siblingCases: prepared
              .filter((x) => x.id !== g.id)
              .map((x) => ({
                id: x.id,
                displayName: x.displayName,
                groupIndex: prepared.indexOf(x) + 1,
              })),
            note: `This PDF was separated into ${prepared.length} cases. Review each case separately.`,
          },
        });
      }
    await update(97, "Saving reviewed results");
    await assertLease();
    if (reviewInputDigest(await readManifest()) !== manifestDigest)
      throw new ReviewContractError(
        "Uploaded documents changed during review. Analyze the updated case again.",
      );
    const performance = {
      queueWaitMs: job.created_at
        ? Math.max(0, performanceStartedAt - new Date(job.created_at).getTime())
        : null,
      processingBeforeSaveMs: Date.now() - performanceStartedAt,
      phases,
      extractionCheckpointReused: extraction.reused,
    };
    const saveStartedAt = Date.now();
    const complete = await db.rpc("complete_case_job", {
      p_job: jobId,
      p_worker: worker,
      p_groups: prepared,
      p_result: {
        createdCaseIds: prepared.map((g) => g.id),
        verificationGroupCount: prepared.reduce(
          (total, group) =>
            total +
            (Array.isArray(group.meta.verificationGroups)
              ? group.meta.verificationGroups.length
              : 0),
          0,
        ),
        extractionReview: reviewed.review,
        performance,
      },
    });
    if (complete.error) throw complete.error;
    await checkpoints.clearUsed();
    phases.persistResultsMs = Date.now() - saveStartedAt;
    console.info(
      JSON.stringify({
        scope: "case-processing-timing",
        jobId,
        totalMs: Date.now() - performanceStartedAt,
        ...performance,
        phases,
      }),
    );
    return { skipped: false, caseIds: prepared.map((g) => g.id) };
  } catch (error) {
    const failed = await db.rpc("fail_case_job", {
      p_job: jobId,
      p_worker: worker,
      p_error: message(error),
      p_retry: !isTerminalProcessingError(error),
    });
    if (failed.error)
      console.error("Unable to record job failure", failed.error.message);
    throw error;
  } finally {
    clearInterval(leaseHeartbeat);
    await leaseHeartbeatInFlight;
  }
}
