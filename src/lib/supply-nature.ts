import type { CaseDoc, DocType } from "@/types/pipeline";

export type SupplyNature = {
  kind: "goods" | "services" | "mixed" | "unknown";
  evidence: Array<{ sourcePage: number; quote: string }>;
};
export const SUPPLY_NATURE_FIELD = "__supplyNature";

export function readSupplyNature(raw: unknown): SupplyNature | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const value = raw as Record<string, unknown>;
  if (
    !["goods", "services", "mixed", "unknown"].includes(String(value.kind)) ||
    !Array.isArray(value.evidence)
  )
    return;
  const evidence = value.evidence.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const proof = entry as Record<string, unknown>;
    return Number.isInteger(proof.sourcePage) &&
      Number(proof.sourcePage) > 0 &&
      typeof proof.quote === "string" &&
      proof.quote.trim()
      ? [{ sourcePage: Number(proof.sourcePage), quote: proof.quote }]
      : [];
  });
  if (
    value.kind !== "unknown" &&
    (!evidence.length || evidence.length !== value.evidence.length)
  )
    return;
  return { kind: value.kind as SupplyNature["kind"], evidence };
}

export function storedSupplyNature(fields: unknown) {
  return fields && typeof fields === "object"
    ? readSupplyNature((fields as Record<string, unknown>)[SUPPLY_NATURE_FIELD])
    : undefined;
}

export function isServiceOnlyPacket(
  documents: Pick<CaseDoc, "type" | "supplyNature">[],
) {
  const invoices = documents.filter(
    (doc) => doc.type === "Invoice" || doc.type === "Tax Invoice",
  );
  return (
    invoices.length > 0 &&
    invoices.every(
      (doc) => readSupplyNature(doc.supplyNature)?.kind === "services",
    )
  );
}

/** Applicability policy, not recognition by names, number patterns or missing files. */
export const GOODS_ONLY_DOCUMENT_TYPES: readonly DocType[] = [
  "Weighment Slip",
  "Lorry Receipt",
  "E-Way Bill",
  "Material Test Certificate",
  "Delivery Note",
  "Delivery Challan",
  "Transport Permit",
  "Vehicle Registration Certificate",
  "Driving Licence",
  "FASTag Toll Proof",
  "Map Printout",
];
