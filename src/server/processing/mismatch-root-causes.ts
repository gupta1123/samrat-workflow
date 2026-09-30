import { UNRELATED_DOCUMENT_FIELD } from "../../lib/unrelated-document";
import type { Mismatch } from "../../types/pipeline";

export type RootCauseCandidate = {
  reviewId: string;
  mismatch: Mismatch;
};

type RootIssue = {
  issueId: string;
  kind: "field_discrepancy" | "unrelated_document";
  primaryMismatchId: string;
  memberMismatchIds: string[];
  outlierDocumentIds: string[];
  title: string;
  reason: string;
};

type DismissedIssue = { mismatchId: string; reason: string };

export type ValidatedRootCauseReview = {
  rootIssues: RootIssue[];
  dismissedMismatchIds: DismissedIssue[];
};

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`Root-cause review omitted ${label}.`);
  return text;
}

function uniqueStringArray(value: unknown, label: string) {
  if (!Array.isArray(value)) {
    throw new Error(`Root-cause review omitted ${label}.`);
  }
  const entries = value.map((entry) => nonEmptyString(entry, label));
  if (new Set(entries).size !== entries.length) {
    throw new Error(`Root-cause review duplicated ${label}.`);
  }
  return entries;
}

export function buildRootCauseCandidates(
  mismatches: Mismatch[],
): RootCauseCandidate[] {
  return mismatches.map((mismatch, index) => ({
    reviewId: `confirmed-${index + 1}`,
    mismatch,
  }));
}

export function validateRootCauseReview(
  value: unknown,
  candidates: RootCauseCandidate[],
): ValidatedRootCauseReview {
  const payload = record(value, "Root-cause review did not return an object.");
  if (!Array.isArray(payload.rootIssues)) {
    throw new Error("Root-cause review omitted rootIssues.");
  }
  if (!Array.isArray(payload.dismissedMismatchIds)) {
    throw new Error("Root-cause review omitted dismissedMismatchIds.");
  }
  const byId = new Map(
    candidates.map((candidate) => [candidate.reviewId, candidate]),
  );
  const accounted = new Set<string>();
  const issueIds = new Set<string>();

  const rootIssues = payload.rootIssues.map((rawIssue): RootIssue => {
    const issue = record(
      rawIssue,
      "Root-cause review returned a malformed root issue.",
    );
    const issueId = nonEmptyString(issue.issueId, "issueId");
    if (issueIds.has(issueId))
      throw new Error("Root-cause review duplicated issueId.");
    issueIds.add(issueId);
    const kind = nonEmptyString(issue.kind, "kind");
    if (kind !== "field_discrepancy" && kind !== "unrelated_document") {
      throw new Error(
        `Root-cause review returned an invalid kind for ${issueId}.`,
      );
    }
    const primaryMismatchId = nonEmptyString(
      issue.primaryMismatchId,
      "primaryMismatchId",
    );
    const memberMismatchIds = uniqueStringArray(
      issue.memberMismatchIds,
      "memberMismatchIds",
    );
    const outlierDocumentIds = uniqueStringArray(
      issue.outlierDocumentIds,
      "outlierDocumentIds",
    );
    if (
      !memberMismatchIds.length ||
      !memberMismatchIds.includes(primaryMismatchId)
    ) {
      throw new Error(
        `${issueId} must include its primary mismatch among its members.`,
      );
    }
    if (kind === "field_discrepancy" && memberMismatchIds.length !== 1) {
      throw new Error(
        `${issueId} cannot group independent field discrepancies.`,
      );
    }
    if (kind === "unrelated_document" && !outlierDocumentIds.length) {
      throw new Error(`${issueId} must identify the unrelated document.`);
    }
    for (const mismatchId of memberMismatchIds) {
      const candidate = byId.get(mismatchId);
      if (!candidate)
        throw new Error(`${issueId} references an unknown mismatch.`);
      if (accounted.has(mismatchId)) {
        throw new Error(
          `Root-cause review accounted for ${mismatchId} more than once.`,
        );
      }
      accounted.add(mismatchId);
      const evidenceDocumentIds = new Set(
        candidate.mismatch.values.map((entry) => entry.docId).filter(Boolean),
      );
      const invalidOutliers = outlierDocumentIds.filter(
        (docId) => !evidenceDocumentIds.has(docId),
      );
      if (invalidOutliers.length) {
        throw new Error(
          `${issueId} attributes a mismatch to evidence it does not cite.`,
        );
      }
      if (kind === "unrelated_document") {
        const hasOutlier = candidate.mismatch.values.some((entry) =>
          outlierDocumentIds.includes(entry.docId),
        );
        const hasReference = candidate.mismatch.values.some(
          (entry) => !outlierDocumentIds.includes(entry.docId),
        );
        if (!hasOutlier || !hasReference) {
          throw new Error(
            `${issueId} lacks both outlier and corroborating evidence.`,
          );
        }
      }
    }
    return {
      issueId,
      kind,
      primaryMismatchId,
      memberMismatchIds,
      outlierDocumentIds,
      title: nonEmptyString(issue.title, "title"),
      reason: nonEmptyString(issue.reason, "reason"),
    };
  });

  const dismissedMismatchIds = payload.dismissedMismatchIds.map(
    (rawDismissed): DismissedIssue => {
      const dismissed = record(
        rawDismissed,
        "Root-cause review returned a malformed dismissal.",
      );
      const mismatchId = nonEmptyString(dismissed.mismatchId, "mismatchId");
      if (!byId.has(mismatchId)) {
        throw new Error("Root-cause review dismissed an unknown mismatch.");
      }
      if (accounted.has(mismatchId)) {
        throw new Error(
          `Root-cause review accounted for ${mismatchId} more than once.`,
        );
      }
      accounted.add(mismatchId);
      return {
        mismatchId,
        reason: nonEmptyString(dismissed.reason, "dismissal reason"),
      };
    },
  );

  if (accounted.size !== candidates.length) {
    const missing = candidates
      .map((candidate) => candidate.reviewId)
      .filter((reviewId) => !accounted.has(reviewId));
    throw new Error(
      `Root-cause review did not account for: ${missing.join(", ")}.`,
    );
  }
  return { rootIssues, dismissedMismatchIds };
}

export function materializeRootCauseMismatches(
  review: ValidatedRootCauseReview,
  candidates: RootCauseCandidate[],
): Array<Mismatch & { analysis: string }> {
  const byId = new Map(
    candidates.map((candidate) => [candidate.reviewId, candidate]),
  );
  return review.rootIssues.map((issue) => {
    const primary = byId.get(issue.primaryMismatchId)!.mismatch;
    if (issue.kind === "field_discrepancy") {
      return {
        ...primary,
        analysis: `Authoritative root-cause review: ${issue.reason}`,
      };
    }
    const memberMismatches = issue.memberMismatchIds.map(
      (memberId) => byId.get(memberId)!.mismatch,
    );
    return {
      id: `root-cause-${primary.id}`,
      field: UNRELATED_DOCUMENT_FIELD,
      values: memberMismatches.flatMap((mismatch) =>
        mismatch.values.map((entry) => ({
          ...entry,
          evidenceField: mismatch.field,
          isOutlier: issue.outlierDocumentIds.includes(entry.docId),
        })),
      ),
      analysis: `Authoritative root-cause review: ${issue.reason}`,
      fixPlan:
        "Remove or replace the unrelated document, then analyze the packet again.",
    };
  });
}

export const ROOT_CAUSE_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    rootIssues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          kind: {
            type: "string",
            enum: ["field_discrepancy", "unrelated_document"],
          },
          primaryMismatchId: { type: "string" },
          memberMismatchIds: { type: "array", items: { type: "string" } },
          outlierDocumentIds: { type: "array", items: { type: "string" } },
          title: { type: "string" },
          reason: { type: "string" },
        },
        required: [
          "issueId",
          "kind",
          "primaryMismatchId",
          "memberMismatchIds",
          "outlierDocumentIds",
          "title",
          "reason",
        ],
        additionalProperties: false,
      },
    },
    dismissedMismatchIds: {
      type: "array",
      items: {
        type: "object",
        properties: {
          mismatchId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["mismatchId", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["rootIssues", "dismissedMismatchIds"],
  additionalProperties: false,
} satisfies Record<string, unknown>;
