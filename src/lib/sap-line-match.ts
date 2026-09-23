export type ComparableSapLine = {
  itemCode?: string | null;
  description?: string | null;
  quantity?: number | null;
  price?: number | null;
};

export type ComparablePacketLine = {
  itemCode?: string | null;
  description?: string | null;
  quantity?: string | number | null;
  rate?: string | number | null;
};

export function normalizeSapItem(value: unknown): string {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function numeric(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(result) ? result : null;
}

export function selectSapLine<T extends ComparableSapLine>(
  packet: ComparablePacketLine,
  sapLines: T[],
  used: Set<number>,
): { index: number; line: T; confidence: "exact" | "fuzzy" } | null {
  const item = normalizeSapItem(packet.itemCode);
  const description = normalizeSapItem(packet.description);
  const quantity = numeric(packet.quantity);
  const rate = numeric(packet.rate);
  const candidates = sapLines.flatMap((line, index) => {
    if (used.has(index)) return [];
    const sapItem = normalizeSapItem(line.itemCode);
    const sapDescription = normalizeSapItem(line.description);
    const itemExact = Boolean(item && sapItem && item === sapItem);
    const descriptionExact = Boolean(description && sapDescription && description === sapDescription);
    const descriptionSimilar = Boolean(
      description.length >= 6 && sapDescription.length >= 6 &&
      (description.includes(sapDescription) || sapDescription.includes(description)),
    );
    if (!itemExact && !descriptionExact && !descriptionSimilar) return [];
    const qtyExact = quantity !== null && line.quantity !== null && line.quantity !== undefined &&
      Math.abs(quantity - line.quantity) < 0.0001;
    const rateExact = rate !== null && line.price !== null && line.price !== undefined &&
      Math.abs(rate - line.price) < 0.01;
    const score = (itemExact ? 100 : 0) + (descriptionExact ? 40 : descriptionSimilar ? 15 : 0) +
      (qtyExact ? 20 : 0) + (rateExact ? 30 : 0);
    return [{ index, line, score, confidence: itemExact || descriptionExact ? "exact" as const : "fuzzy" as const }];
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const best = candidates[0];
  if (!best) return null;
  used.add(best.index);
  return { index: best.index, line: best.line, confidence: best.confidence };
}
