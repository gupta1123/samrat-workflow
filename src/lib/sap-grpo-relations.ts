export type SapPurchaseOrderIdentity = {
  DocEntry?: number;
  CardCode?: string;
};

export type SapGrpoRelationship = {
  DocEntry?: number;
  DocumentStatus?: string;
  Cancelled?: string;
  CardCode?: string;
  DocumentLines?: Array<{
    BaseType?: number;
    BaseEntry?: number | null;
    LineStatus?: string;
    RemainingOpenQuantity?: number;
  }>;
};

/**
 * Select open GRPOs by SAP's own document relationship. A GRPO line created
 * from a purchase order has BaseType 22 and BaseEntry equal to that PO's
 * DocEntry. This is an authoritative foreign-key relationship, not a text,
 * description, or document-number guess.
 */
export function selectOpenGrposBasedOnPurchaseOrders<
  T extends SapGrpoRelationship,
>(documents: T[], purchaseOrders: SapPurchaseOrderIdentity[]): T[] {
  const poEntriesByVendor = new Map<string, Set<number>>();

  for (const purchaseOrder of purchaseOrders) {
    if (
      typeof purchaseOrder.CardCode !== "string" ||
      !purchaseOrder.CardCode.trim() ||
      !Number.isSafeInteger(purchaseOrder.DocEntry) ||
      Number(purchaseOrder.DocEntry) <= 0
    ) {
      continue;
    }
    const entries = poEntriesByVendor.get(purchaseOrder.CardCode) ?? new Set();
    entries.add(Number(purchaseOrder.DocEntry));
    poEntriesByVendor.set(purchaseOrder.CardCode, entries);
  }

  return documents.filter((document) => {
    if (
      document.DocumentStatus !== "bost_Open" ||
      document.Cancelled !== "tNO" ||
      typeof document.CardCode !== "string"
    ) {
      return false;
    }
    const poEntries = poEntriesByVendor.get(document.CardCode);
    if (!poEntries) return false;

    return (document.DocumentLines ?? []).some(
      (line) =>
        line.BaseType === 22 &&
        typeof line.BaseEntry === "number" &&
        poEntries.has(line.BaseEntry) &&
        line.LineStatus === "bost_Open" &&
        typeof line.RemainingOpenQuantity === "number" &&
        line.RemainingOpenQuantity > 0,
    );
  });
}
