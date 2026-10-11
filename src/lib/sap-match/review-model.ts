// What the SAP tab says about a case, worked out from the saved match result.
// Pure functions so the same wording is used by the header, the sidebar and the tests.
import type { CheckEffect, MatchCheck, MatchResult } from "./types";

export type ReviewTone = "ok" | "todo" | "bad" | "off";

export type ReviewModel = {
  tone: ReviewTone;
  title: string;
  /** Checks that still stop the invoice from going to SAP. */
  pending: MatchCheck[];
  /** The decision that ended the case (correction, duplicate, hold), if any. */
  terminal: { check: MatchCheck; effect: CheckEffect } | null;
  /** Plain names of what is still needed, e.g. "price decision". */
  waiting: string[];
  /** Short reason the Create draft button is off, "" when it is on. */
  blockedReason: string;
  ready: boolean;
  /** Everything is answered but SAP has not built the draft yet. */
  needsRecheck: boolean;
};

export const STEP_NAME: Record<string, string> = {
  rate: "price decision",
  total: "total check",
  part: "partial invoicing",
  anchor: "GRPO confirmation",
  qty: "quantity decision",
  dup: "duplicate decision",
  rcpt: "a matching GRPO",
  map: "item link",
  vendor: "vendor link",
};

export const TERMINAL_TITLE: Partial<Record<CheckEffect, string>> = {
  return: "Correction needed",
  close: "Closed as duplicate",
  hold: "On hold",
};

/** "rate-0" -> "rate", "part-0-12:0" -> "part". */
export function checkRule(id: string): string {
  return id.replace(/-.*$/, "");
}

/** The invoice line a check belongs to, or null for invoice-level checks. */
export function checkLine(check: MatchCheck): number | null {
  if (check.lineIndex !== null && check.lineIndex !== undefined)
    return check.lineIndex;
  const match = /^(rate|qty|rcpt|map|anchor|part)-(\d+)/.exec(check.id);
  return match ? Number(match[2]) : null;
}

/** Checks the reviewer must act on. */
export function pendingChecks(result: MatchResult): MatchCheck[] {
  return result.checks.filter(
    (check) => check.open && check.sev !== "unchecked" && check.sev !== "pass",
  );
}

/** Checks worth showing: still open, or answered by the reviewer. */
export function visibleChecks(result: MatchResult): MatchCheck[] {
  return result.checks.filter(
    (check) =>
      check.sev !== "unchecked" &&
      check.sev !== "pass" &&
      (check.open || check.decision),
  );
}

const listFor = (items: string[]) =>
  items.length > 1
    ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
    : (items[0] ?? "");

export function reviewModel(
  result: MatchResult,
  options: { approved: boolean },
): ReviewModel {
  const pending = pendingChecks(result);
  const ended = result.checks.find(
    (check) =>
      check.decision && TERMINAL_TITLE[check.decision.effect] !== undefined,
  );
  const terminal = ended?.decision
    ? { check: ended, effect: ended.decision.effect }
    : null;
  const hasBlock = pending.some((check) => check.sev === "block");
  const hasWait = pending.some((check) => check.sev === "wait");
  const needsRecheck = !result.payload && pending.length === 0 && !terminal;

  const steps = [
    ...new Set(
      pending.map((check) => STEP_NAME[checkRule(check.id)] ?? check.title),
    ),
  ];
  const waiting = terminal
    ? []
    : needsRecheck
      ? ["a SAP re-check"]
      : [...steps, ...(options.approved ? [] : ["case approval"])];

  let tone: ReviewTone;
  let title: string;
  if (terminal) {
    tone = "off";
    title = TERMINAL_TITLE[terminal.effect] ?? "Closed";
  } else if (hasBlock) {
    tone = "bad";
    title = "Can't send yet";
  } else if (hasWait) {
    tone = "todo";
    title = "Waiting for stores";
  } else if (needsRecheck) {
    tone = "todo";
    title = "Re-check needed";
  } else if (waiting.length) {
    tone = "todo";
    title = `${waiting.length} step${waiting.length > 1 ? "s" : ""} left`;
  } else {
    tone = "ok";
    title = "Ready for SAP draft";
  }

  return {
    tone,
    title,
    pending,
    terminal,
    waiting,
    blockedReason: terminal
      ? title
      : waiting.length
        ? `Waiting for ${listFor(waiting)}`
        : "",
    ready: tone === "ok",
    needsRecheck,
  };
}

/** One line for the sidebar: the next thing the reviewer has to do. */
export function sidebarSummary(model: ReviewModel): {
  pill: string;
  tone: "green" | "red" | "amber" | "grey";
  text: string;
} {
  if (model.tone === "ok")
    return {
      pill: "Ready",
      tone: "green",
      text: "Ready to create A/P Invoice Draft",
    };
  if (model.tone === "off")
    return { pill: model.title, tone: "grey", text: model.title };
  if (model.tone === "bad")
    return {
      pill: "Can't send yet",
      tone: "red",
      text: model.pending[0]?.title ?? model.blockedReason,
    };
  const waiting = model.pending.some((check) => check.sev === "wait");
  return {
    pill: waiting
      ? "Waiting"
      : model.needsRecheck
        ? "Re-check needed"
        : "Needs you",
    tone: "amber",
    text: model.pending[0]?.title ?? model.blockedReason,
  };
}
