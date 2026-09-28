export type ComparableSapLine = {
  itemCode?: string | null;
  description?: string | null;
  quantity?: number | null;
  openQty?: number | null;
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
    const sapQuantity = numeric(line.openQty ?? line.quantity);
    const sapRate = numeric(line.price);
    const qtyComparable = quantity !== null && sapQuantity !== null;
    const rateComparable = rate !== null && sapRate !== null;
    const qtyExact = qtyComparable && Math.abs(quantity - sapQuantity) < 0.0001;
    const rateExact = rateComparable && Math.abs(rate - sapRate) < 0.01;

    // A partial invoice quantity is valid, but an over-quantity line or a
    // different SAP base price is not the same purchasable line. Reject these
    // conflicts instead of allowing an item/description match to hide them.
    if (qtyComparable && quantity > sapQuantity + 0.0001) return [];
    if (rateComparable && !rateExact) return [];

    const score = (itemExact ? 100 : 0) + (descriptionExact ? 40 : descriptionSimilar ? 15 : 0) +
      (qtyExact ? 20 : 0) + (rateExact ? 30 : 0);
    const confidence =
      (itemExact || descriptionExact) &&
      (!qtyComparable || qtyExact) &&
      (!rateComparable || rateExact)
        ? "exact" as const
        : "fuzzy" as const;
    return [{ index, line, score, confidence }];
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const best = candidates[0];
  if (!best) return null;
  used.add(best.index);
  return { index: best.index, line: best.line, confidence: best.confidence };
}
