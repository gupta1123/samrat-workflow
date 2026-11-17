import type { GrpoSapDraftState } from "@/lib/grpo-import";
import type { SapInspectorRecord } from "@/lib/sap-inspector";

export type SapVendorInvoiceReference = {
  cardCode: string;
  invoice: string;
};

export function grpoVendorInvoiceReference(
  receipt: Record<string, unknown>,
  invoiceRefField?: string,
): SapVendorInvoiceReference | null {
  const reference = invoiceRefField ? receipt[invoiceRefField] : undefined;
  const invoice = [reference, receipt.NumAtCard]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value && !/^0+$/.test(value));
  const cardCode =
    typeof receipt.CardCode === "string" ? receipt.CardCode.trim() : "";
  return cardCode && invoice ? { cardCode, invoice } : null;
}

export function sapApDraftsReadPath(
  references: SapVendorInvoiceReference[],
  limit?: number,
) {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const pairs = references.map(
    ({ cardCode, invoice }) =>
      `(CardCode eq ${quote(cardCode)} and NumAtCard eq ${quote(invoice)})`,
  );
  const params = new URLSearchParams({
    $select: "DocEntry,DocNum,CardCode,NumAtCard,Comments,DocObjectCode",
    $filter: `DocObjectCode eq 'oPurchaseInvoices' and (${pairs.join(" or ")})`,
  });
  if (limit !== undefined) params.set("$top", String(limit));
  return `/Drafts?${params}`;
}

export function sapApDraftIdentity(draft: Record<string, unknown>) {
  if (
    draft.DocObjectCode !== "oPurchaseInvoices" ||
    typeof draft.DocEntry !== "number" ||
    !Number.isSafeInteger(draft.DocEntry) ||
    draft.DocEntry <= 0
  )
    return null;
  return {
    status: "created" as const,
    docEntry: String(draft.DocEntry),
    docNum:
      typeof draft.DocNum === "number" &&
      Number.isSafeInteger(draft.DocNum) &&
      draft.DocNum > 0
        ? String(draft.DocNum)
        : undefined,
  };
}

export async function grpoExistingDrafts(
  records: Pick<SapInspectorRecord, "docEntry" | "raw">[],
  invoiceRefField: string | undefined,
  read: (
    references: SapVendorInvoiceReference[],
  ) => Promise<Record<string, unknown>[]>,
) {
  const references = records.flatMap(({ docEntry, raw }) => {
    const reference = grpoVendorInvoiceReference(raw, invoiceRefField);
    return docEntry && reference ? [{ docEntry, reference }] : [];
  });
  const result: Record<string, GrpoSapDraftState> = {};
  if (!references.length) return result;
  const drafts = await read(references.map(({ reference }) => reference));
  for (const { docEntry, reference } of references) {
    for (const row of drafts) {
      if (
        row?.CardCode !== reference.cardCode ||
        row?.NumAtCard !== reference.invoice
      )
        continue;
      const draft = sapApDraftIdentity(row);
      if (draft) {
        result[docEntry] = draft;
        break;
      }
    }
  }
  return result;
}
