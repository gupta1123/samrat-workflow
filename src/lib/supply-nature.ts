import type { CaseDoc, DocType } from "@/types/pipeline";

export const LOGISTICS_REQUIREMENT_KEYS = ["transport", "weightProof"] as const;
export type LogisticsRequirementKey =
  (typeof LOGISTICS_REQUIREMENT_KEYS)[number];
export type LogisticsRequirement = {
  status: "required" | "not_applicable" | "unknown";
  reason: string;
  evidence: Array<{ sourcePage: number; quote: string }>;
};
export type SupplyNature = {
  kind: "goods" | "services" | "mixed" | "unknown";
  evidence: Array<{ sourcePage: number; quote: string }>;
  logisticsRequirements?: Record<LogisticsRequirementKey, LogisticsRequirement>;
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
  let logisticsRequirements: SupplyNature["logisticsRequirements"];
  if (value.logisticsRequirements !== undefined) {
    const raw = value.logisticsRequirements;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const entries = raw as Record<string, unknown>;
    if (
      Object.keys(entries).some(
        (key) =>
          !LOGISTICS_REQUIREMENT_KEYS.includes(key as LogisticsRequirementKey),
      )
    )
      return;
    logisticsRequirements = {} as NonNullable<
      SupplyNature["logisticsRequirements"]
    >;
    for (const key of LOGISTICS_REQUIREMENT_KEYS) {
      const entry = entries[key];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
      const assessment = entry as Record<string, unknown>;
      if (
        Object.keys(assessment).some(
          (key) => !["status", "reason", "evidence"].includes(key),
        ) ||
        !["required", "not_applicable", "unknown"].includes(
          String(assessment.status),
        ) ||
        typeof assessment.reason !== "string" ||
        !assessment.reason.trim() ||
        !Array.isArray(assessment.evidence)
      )
        return;
      const proof = readSupplyNature({
        kind: "goods",
        evidence: assessment.evidence,
      });
      if (!proof) return;
      logisticsRequirements[key] = {
        status: assessment.status as LogisticsRequirement["status"],
        reason: assessment.reason,
        evidence: proof.evidence,
      };
    }
  }
  return {
    kind: value.kind as SupplyNature["kind"],
    evidence,
    ...(logisticsRequirements ? { logisticsRequirements } : {}),
  };
}

/** Source assessments, never item-name patterns or the absence of attachments. */
export function packetLogisticsRequirement(
  documents: Pick<CaseDoc, "type" | "supplyNature">[],
  key: LogisticsRequirementKey,
): LogisticsRequirement["status"] {
  const commercial = documents.filter((doc) =>
    [
      "Invoice",
      "Tax Invoice",
      "Purchase Order",
      "Amended Purchase Order",
    ].includes(doc.type),
  );
  const assessments = commercial.map(
    (doc) => readSupplyNature(doc.supplyNature)?.logisticsRequirements?.[key],
  );
  // Explicit source requirements win over a conflicting exemption.
  if (assessments.some((assessment) => assessment?.status === "required"))
    return "required";
  if (isServiceOnlyPacket(documents)) return "not_applicable";
  // Legacy material packets retain their existing safeguards until reanalysed.
  if (!assessments.some(Boolean)) return "required";
  if (
    assessments.every((assessment) => assessment?.status === "not_applicable")
  )
    return "not_applicable";
  return "unknown";
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
