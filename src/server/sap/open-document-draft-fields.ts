import type { PlannedPayload } from "@/lib/sap-match/types";
import { MatchDraftError } from "./match-draft";

function integer(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/** Header references must come from the exact selected open SAP lines. */
export function openDocumentDraftFields(
  plan: PlannedPayload,
  rows: { grpos: Record<string, unknown>[]; pos: Record<string, unknown>[] },
): { Series: number; AttachmentEntry?: number } {
  const series = new Set<number>();
  const attachments = new Set<number>();
  for (const line of plan.lines) {
    const source = line.baseType === 20 ? rows.grpos : rows.pos;
    const lineKey = line.baseType === 20 ? "Line Num" : "PO Line Num";
    const matches = source.filter(
      (row) =>
        integer(row.DocEntry) === line.baseEntry &&
        integer(row[lineKey]) === line.baseLine &&
        row["BP Code"] === plan.cardCode,
    );
    if (!matches.length) {
      throw new MatchDraftError(
        `SAP Open Documents did not return selected document ${line.baseDocNum}, line ${line.baseLine}. Refresh the match; no draft was created.`,
      );
    }
    for (const row of matches) {
      const code = integer(row.InvoiceSeriesCode);
      if (code === null || code <= 0) {
        throw new MatchDraftError(
          `SAP document ${line.baseDocNum} has no valid InvoiceSeriesCode. Ask the SAP team to correct the Open Documents response.`,
        );
      }
      series.add(code);
      const attachment = integer(row.AtcEntry);
      if (
        row.AtcEntry !== null &&
        row.AtcEntry !== undefined &&
        row.AtcEntry !== "" &&
        (attachment === null || attachment < -1)
      ) {
        throw new MatchDraftError(
          `SAP document ${line.baseDocNum} returned an invalid attachment reference.`,
        );
      }
      if (attachment !== null && attachment > 0) attachments.add(attachment);
    }
  }
  if (series.size !== 1) {
    throw new MatchDraftError(
      "The selected SAP documents have different invoice series. SAP must provide one compatible series before creating this draft.",
    );
  }
  if (attachments.size > 1) {
    throw new MatchDraftError(
      "The selected SAP documents have different attachment entries. SAP accepts one AttachmentEntry per draft. Ask the SAP team to provide a combined attachment entry; no attachment was chosen arbitrarily.",
    );
  }
  return {
    Series: [...series][0],
    ...(attachments.size ? { AttachmentEntry: [...attachments][0] } : {}),
  };
}
