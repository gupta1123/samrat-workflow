export type ExactPoHeader = {
  DocEntry?: number;
  DocNum?: number;
  CardName?: string;
  DocumentStatus?: string;
  Cancelled?: string;
};

export type ExactPoPacketLine = {
  itemCode?: string | null;
  quantity?: string | number | null;
  rate?: string | number | null;
};

export type ExactPoSapLine = {
  ItemCode?: string | null;
  RemainingOpenQuantity?: number | null;
  Price?: number | null;
};

function exactText(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(String(value).replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function sapDocumentNumber(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

export function selectUniqueExactOpenPurchaseOrder<T extends ExactPoHeader>(
  documents: T[],
  requestedDocNum: number,
  vendorName: string,
): T | null {
  const exactVendor = exactText(vendorName);
  if (!exactVendor) return null;

  const matches = documents.filter(
    (document) =>
      document.DocNum === requestedDocNum &&
      document.DocumentStatus === "bost_Open" &&
      document.Cancelled === "tNO" &&
      exactText(document.CardName) === exactVendor &&
      Number.isSafeInteger(document.DocEntry) &&
      Number(document.DocEntry) > 0,
  );

  return matches.length === 1 ? matches[0] : null;
}

export function assignExactOpenPoLines(
  packetLines: ExactPoPacketLine[],
  sapLines: ExactPoSapLine[],
): number[] | null {
  if (packetLines.length === 0) return null;

  const used = new Set<number>();
  const assignments: number[] = [];

  for (const packetLine of packetLines) {
    const itemCode = exactText(packetLine.itemCode);
    const quantity = finiteNumber(packetLine.quantity);
    const rate = finiteNumber(packetLine.rate);
    if (!itemCode || quantity === null || quantity <= 0 || rate === null) {
      return null;
    }

    const candidates = sapLines.flatMap((sapLine, index) => {
      if (used.has(index) || exactText(sapLine.ItemCode) !== itemCode) return [];
      const openQuantity = finiteNumber(sapLine.RemainingOpenQuantity);
      const sapRate = finiteNumber(sapLine.Price);
      if (
        openQuantity === null ||
        openQuantity < quantity ||
        sapRate === null ||
        Math.round(sapRate * 100) !== Math.round(rate * 100)
      ) {
        return [];
      }
      return [index];
    });

    if (candidates.length !== 1) return null;
    used.add(candidates[0]);
    assignments.push(candidates[0]);
  }

  return assignments;
}
