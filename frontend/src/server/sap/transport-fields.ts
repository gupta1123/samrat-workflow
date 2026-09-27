const EMPTY_SAP_VALUES = new Set(["", "-", "NA", "N/A", "NONE", "NULL"]);

export type SapTransportOption = {
  value: string;
  label: string;
};

export type PacketDocumentEvidence = {
  extracted_fields?: unknown;
};

export type SapTransportResolution =
  | {
      status: "selected";
      value: string;
      label: string;
      source: "draft" | "base" | "packet";
    }
  | { status: "missing" }
  | { status: "invalid"; candidates: string[] }
  | { status: "ambiguous"; candidates: string[] };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function identity(value: string): string {
  return value.trim().toLocaleUpperCase("en");
}

export function usableSapText(value: unknown): value is string {
  return typeof value === "string" && !EMPTY_SAP_VALUES.has(identity(value));
}

function configuredOption(
  candidate: string,
  allowedOptions: SapTransportOption[],
): SapTransportOption | null {
  const candidateIdentity = identity(candidate);
  return (
    allowedOptions.find(
      (option) =>
        identity(option.value) === candidateIdentity ||
        identity(option.label) === candidateIdentity,
    ) ?? null
  );
}

function packetTransportCandidates(
  documents: PacketDocumentEvidence[],
  invoiceNumber: string,
): string[] {
  const invoiceIdentity = identity(invoiceNumber);
  const values = documents.flatMap((document) => {
    const fields = record(document.extracted_fields);
    const linkedInvoice =
      text(fields.referenceInvoiceNumber) || text(fields.invoiceNumber);
    const transporter = text(fields.transporterName);
    return identity(linkedInvoice) === invoiceIdentity &&
      usableSapText(transporter)
      ? [transporter]
      : [];
  });
  return [
    ...new Map(
      values.map((value) => [identity(value), value] as const),
    ).values(),
  ];
}

/**
 * Resolve a transporter only from authoritative SAP configuration and exact
 * document relationships. Packet values are accepted only when they exactly
 * match a current SAP value or description; this function never guesses.
 */
export function resolveSapTransporter(input: {
  draftValue: unknown;
  baseValue: unknown;
  packetDocuments: PacketDocumentEvidence[];
  invoiceNumber: string;
  allowedOptions: SapTransportOption[];
}): SapTransportResolution {
  for (const [source, candidate] of [
    ["draft", input.draftValue],
    ["base", input.baseValue],
  ] as const) {
    if (!usableSapText(candidate)) continue;
    const option = configuredOption(candidate, input.allowedOptions);
    if (option) return { status: "selected", ...option, source };
  }

  const candidates = packetTransportCandidates(
    input.packetDocuments,
    input.invoiceNumber,
  );
  if (candidates.length === 0) return { status: "missing" };

  const matches = candidates.flatMap((candidate) => {
    const option = configuredOption(candidate, input.allowedOptions);
    return option ? [option] : [];
  });
  const uniqueMatches = [
    ...new Map(
      matches.map((option) => [identity(option.value), option]),
    ).values(),
  ];
  if (uniqueMatches.length === 1 && uniqueMatches[0]) {
    return { status: "selected", ...uniqueMatches[0], source: "packet" };
  }
  if (uniqueMatches.length > 1) {
    return { status: "ambiguous", candidates };
  }
  return { status: "invalid", candidates };
}

/** Copy one SAP-configured field without inferring its technical name. */
export function sapTransportFieldUpdates(
  draft: Record<string, unknown>,
  propertyName: string,
  value: string,
): Record<string, string> {
  return usableSapText(draft[propertyName]) ? {} : { [propertyName]: value };
}

export function transportFieldsMatch(
  document: Record<string, unknown>,
  expected: Record<string, string>,
): boolean {
  return Object.entries(expected).every(
    ([key, value]) =>
      typeof document[key] === "string" &&
      document[key].trim() === value.trim(),
  );
}
