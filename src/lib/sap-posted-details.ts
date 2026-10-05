import type { SapMatchAvailable } from "./sap-match-client";
import type { DraftHeaderPreview } from "./sap-draft-fields";
import type { SapDocumentSnapshot } from "./sap-posting-preview";

export type SavedSapMatch = Pick<
  SapMatchAvailable,
  "invoice" | "vendor" | "branch" | "result"
> & { version: 1 };
export type PostedSapDetails = {
  invoiceNumber: string | null;
  vendorCode: string | null;
  vendorName: string | null;
  postingDate: string | null;
  invoiceDate: string | null;
  recordedAt: string | null;
  draftNumber: string | null;
  materialForm: string | null;
  currency: string | null;
  total: number | null;
  netPayable: number | null;
  bases: Array<{ kind: "GRPO" | "PO"; number: string }>;
  lines: Array<{
    itemCode: string | null;
    description: string | null;
    quantity: number | null;
    rate: number | null;
    amount: number | null;
  }>;
  match: SavedSapMatch | null;
  history: Array<{ at: string; title: string }>;
  nextCaseId: string | null;
  draftDocNum?: string | null;
  headerFields?: DraftHeaderPreview["fields"];
  sapSnapshot?: SapDocumentSnapshot | null;
  submittedPayload?: Record<string, unknown> | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : null;
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function postingLineSnapshot(value: unknown) {
  return (Array.isArray(value) ? value : []).map((candidate) => {
    const line = record(candidate);
    return {
      ItemCode: text(line.ItemCode),
      ItemDescription: text(line.ItemDescription),
      Quantity: number(line.Quantity),
      UnitPrice: number(line.UnitPrice),
      LineTotal: number(line.LineTotal),
      BaseType: number(line.BaseType),
      BaseEntry: number(line.BaseEntry),
      BaseLine: number(line.BaseLine),
    };
  });
}

// Keep the result used to create the draft. A later job may reject receipts
// that closed after posting, so it cannot describe the historical match.
export function saveSapMatch(
  match: Pick<SapMatchAvailable, "invoice" | "vendor" | "branch" | "result">,
  postingDate: string,
): SavedSapMatch {
  return {
    version: 1,
    invoice: match.invoice,
    vendor: match.vendor,
    branch: match.branch,
    result: {
      ...match.result,
      postingDate,
      payload: match.result.payload
        ? { ...match.result.payload, docDate: postingDate }
        : null,
    },
  };
}

function savedMatch(
  value: unknown,
  invoiceNumber: string | null,
  vendorCode: string | null,
): SavedSapMatch | null {
  const candidate = record(value),
    invoice = record(candidate.invoice),
    result = record(candidate.result);
  const payload = record(result.payload),
    vendor = record(candidate.vendor);
  if (
    candidate.version !== 1 ||
    result.status !== "ready" ||
    !invoiceNumber ||
    invoice.invoiceNumber !== invoiceNumber ||
    !vendorCode ||
    vendor.cardCode !== vendorCode ||
    payload.cardCode !== vendorCode ||
    !Array.isArray(invoice.lines) ||
    !Array.isArray(invoice.vehicles) ||
    !Array.isArray(invoice.poReferences) ||
    !Array.isArray(result.checks) ||
    !Array.isArray(result.open) ||
    result.open.length !== 0 ||
    !Array.isArray(result.lines) ||
    !Array.isArray(result.baseDocuments) ||
    !Array.isArray(payload.lines) ||
    result.checks.some(
      (check) =>
        typeof record(check).id !== "string" ||
        typeof record(check).title !== "string",
    ) ||
    payload.lines.some((line) => typeof record(line).itemCode !== "string") ||
    result.lines.some((line) => {
      const row = record(line);
      return (
        typeof row.index !== "number" ||
        !Array.isArray(row.candidates) ||
        row.candidates.some((candidate) => {
          const item = record(candidate);
          return (
            typeof item.key !== "string" ||
            !Array.isArray(item.good) ||
            !Array.isArray(item.bad)
          );
        })
      );
    })
  )
    return null;
  return candidate as SavedSapMatch;
}

export function postedSapDetails(
  posting: { payload?: unknown; response?: unknown; updated_at?: string },
  events: Array<{ action: string; created_at: string }> = [],
  nextCaseId: string | null = null,
): PostedSapDetails {
  const payload = record(posting.payload),
    response = record(posting.response),
    summary = record(response.PostingSummary);
  const invoiceNumber =
    text(summary.invoiceNumber) ?? text(payload.invoiceNumber);
  const vendorCode = text(summary.vendorCode) ?? text(response.CardCode);
  const sources = Array.isArray(payload.baseDocuments)
    ? payload.baseDocuments
    : [{ kind: payload.baseKind, docNum: payload.baseDocNum }];
  const bases: PostedSapDetails["bases"] = sources.flatMap((source) => {
    const row = record(source),
      kind = row.kind,
      num = text(row.docNum);
    return (kind === "GRPO" || kind === "PO") && num
      ? [{ kind, number: num }]
      : [];
  });
  const actions: Record<string, string> = {
    sap_ap_draft_created: "A/P Invoice Draft saved in SAP",
    sap_ap_draft_linked: "Existing A/P Invoice Draft linked",
    sap_ap_invoice_posted: "A/P Invoice posted in SAP",
    sap_ap_invoice_linked: "Existing A/P Invoice linked",
  };
  const match = savedMatch(payload.matchSnapshot, invoiceNumber, vendorCode);
  const header = record(payload.draftHeaderFields);
  const evidence = Array.isArray(payload.draftHeaderEvidence)
    ? payload.draftHeaderEvidence
    : [];
  return {
    invoiceNumber,
    vendorCode,
    vendorName: text(summary.vendorName) ?? match?.vendor?.cardName ?? null,
    postingDate: text(summary.postingDate) ?? text(payload.postingDate),
    invoiceDate: text(summary.invoiceDate) ?? text(payload.invoiceDate),
    recordedAt: posting.updated_at ?? null,
    draftNumber: text(response.DraftDocEntry) ?? text(response.DocEntry),
    draftDocNum: text(response.DocNum),
    materialForm: text(response.MaterialForm) ?? text(header.U_MTRFORM),
    currency: text(summary.currency),
    total: number(summary.total),
    netPayable: number(summary.netPayable),
    bases,
    lines: (Array.isArray(summary.lines) ? summary.lines : []).map((line) => {
      const row = record(line);
      return {
        itemCode: text(row.ItemCode),
        description: text(row.ItemDescription),
        quantity: number(row.Quantity),
        rate: number(row.UnitPrice),
        amount: number(row.LineTotal),
      };
    }),
    match,
    history: events
      .filter((event) => typeof actions[event.action] === "string")
      .map((event) => ({ at: event.created_at, title: actions[event.action] })),
    nextCaseId,
    headerFields: evidence.flatMap((field) => {
      const row = record(field);
      const key = text(row.key),
        label = text(row.label);
      return key && label
        ? [
            {
              key,
              label,
              value: text(key in header ? header[key] : row.value),
              source: text(row.source) ?? "Saved",
            },
          ]
        : [];
    }),
    sapSnapshot: record(response.SapDocumentSnapshot).document
      ? (response.SapDocumentSnapshot as SapDocumentSnapshot)
      : null,
    submittedPayload: Object.keys(record(payload.submittedPayload)).length
      ? record(payload.submittedPayload)
      : null,
  };
}
