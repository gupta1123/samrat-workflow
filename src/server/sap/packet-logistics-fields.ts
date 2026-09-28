type SapField = Record<string, unknown>;

export type PacketLogisticsDocument = {
  document_type?: unknown;
  extracted_fields?: unknown;
};

type CandidateKind = "text" | "date" | "weight" | "vehicleType";

type FieldRule = {
  description: string;
  kind: CandidateKind;
  packetField: string;
  documentTypes?: string[];
};

export type PacketLogisticsUpdate = {
  description: string;
  propertyName: string;
  value: string | number;
};

const RULES: FieldRule[] = [
  { description: "Vehicle NO", kind: "text", packetField: "vehicleNumber" },
  { description: "Driver Name", kind: "text", packetField: "driverName" },
  { description: "Driver Mobile", kind: "text", packetField: "driverMobile" },
  {
    description: "LR No",
    kind: "text",
    packetField: "lorryReceiptNumber",
  },
  {
    description: "LR Date",
    kind: "date",
    packetField: "documentDate",
    documentTypes: ["Lorry Receipt"],
  },
  {
    description: "Waybill No.",
    kind: "text",
    packetField: "eWayBillNumber",
  },
  {
    description: "Weighbridge Transaction Id",
    kind: "text",
    packetField: "weighmentNumber",
    documentTypes: ["Weighment Slip"],
  },
  {
    description: "Vehicle Type",
    kind: "vehicleType",
    packetField: "vehicleClass",
  },
  {
    description: "Tata Kata Weight",
    kind: "weight",
    packetField: "netWeight",
    documentTypes: ["Invoice", "Tax Invoice"],
  },
  {
    description: "Samrat Kata Wt",
    kind: "weight",
    packetField: "netWeight",
    documentTypes: ["Weighment Slip"],
  },
  {
    description: "TATA Gross Weight",
    kind: "weight",
    packetField: "grossWeight",
    documentTypes: ["Invoice", "Tax Invoice"],
  },
  {
    description: "Tata Tare Weight",
    kind: "weight",
    packetField: "tareWeight",
    documentTypes: ["Invoice", "Tax Invoice"],
  },
  {
    description: "Samrat Gross Weight",
    kind: "weight",
    packetField: "grossWeight",
    documentTypes: ["Weighment Slip"],
  },
  {
    description: "Samrat Tare Weight",
    kind: "weight",
    packetField: "tareWeight",
    documentTypes: ["Weighment Slip"],
  },
];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function scalarText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "";
}

function identity(value: string): string {
  return value.toLocaleUpperCase("en");
}

function useful(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  const valueText = text(value);
  return Boolean(valueText) &&
    !["-", "0", "NA", "N/A", "NONE", "NULL"].includes(identity(valueText));
}

function dateValue(value: unknown): string | null {
  const valueText = text(value);
  if (!valueText || Number.isNaN(Date.parse(valueText))) return null;
  const iso = new Date(valueText).toISOString();
  return iso.slice(0, 10);
}

function weightTonnes(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const valueText = text(value).replaceAll(",", "");
  if (!valueText) return null;
  const parts = valueText.split(" ").filter(Boolean);
  const amount = Number(parts[0]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = parts.slice(1).join("").toLocaleUpperCase("en");
  if (!unit || ["MT", "MTS", "TON", "TONS", "TONNE", "TONNES"].includes(unit)) {
    return amount;
  }
  if (["KG", "KGS", "KILOGRAM", "KILOGRAMS"].includes(unit)) {
    return amount / 1000;
  }
  return null;
}

function distinctCandidates(
  documents: PacketLogisticsDocument[],
  rule: FieldRule,
): Array<string | number> {
  const values: Array<string | number> = [];
  for (const document of documents) {
    const documentType = text(document.document_type);
    if (rule.documentTypes && !rule.documentTypes.includes(documentType)) {
      continue;
    }
    const raw = record(document.extracted_fields)[rule.packetField];
    if (!useful(raw)) continue;
    if (rule.kind === "date") {
      const parsed = dateValue(raw);
      if (parsed) values.push(parsed);
      continue;
    }
    if (rule.kind === "weight") {
      const parsed = weightTonnes(raw);
      if (parsed !== null) values.push(parsed);
      continue;
    }
    const parsed = scalarText(raw);
    if (parsed) values.push(parsed);
  }
  return [
    ...new Map(
      values.map((value) => [
        typeof value === "number" ? String(value) : identity(value),
        value,
      ] as const),
    ).values(),
  ];
}

function validValues(field: SapField): Array<{ value: string; label: string }> {
  const source = Array.isArray(field.ValidValuesMD)
    ? field.ValidValuesMD
    : Array.isArray(field.ValidValues)
      ? field.ValidValues
      : [];
  return source.flatMap((candidate) => {
    const option = record(candidate);
    const value = text(option.Value) || text(option.value);
    const label = text(option.Description) || text(option.description) || value;
    return value ? [{ value, label }] : [];
  });
}

function sapValue(field: SapField, candidate: string | number): string | number | null {
  const options = validValues(field);
  if (options.length === 0) return candidate;
  const candidateIdentity = identity(String(candidate));
  const matches = options.filter(
    (option) =>
      identity(option.value) === candidateIdentity ||
      identity(option.label) === candidateIdentity,
  );
  return matches.length === 1 ? matches[0]!.value : null;
}

function sameValue(left: unknown, right: string | number): boolean {
  if (typeof right === "number") {
    const parsed = Number(left);
    return Number.isFinite(parsed) && Math.abs(parsed - right) <= 0.000001;
  }
  return identity(text(left)) === identity(right);
}

/**
 * Builds optional SAP UDF updates only from unique packet evidence and live SAP
 * metadata. Technical UDF names and client values are never guessed.
 */
export async function packetLogisticsFieldUpdates(input: {
  draft: Record<string, unknown>;
  documents: PacketLogisticsDocument[];
  invoiceNumber: string;
  getUserFields: (
    tableName: string,
    description: string,
  ) => Promise<SapField[]>;
}): Promise<PacketLogisticsUpdate[]> {
  const expectedInvoice = identity(input.invoiceNumber);
  const invoiceNumbers = [
    ...new Set(
      input.documents.flatMap((document) => {
        const documentType = text(document.document_type);
        if (documentType !== "Invoice" && documentType !== "Tax Invoice") {
          return [];
        }
        const invoiceNumber = text(record(document.extracted_fields).invoiceNumber);
        return invoiceNumber ? [identity(invoiceNumber)] : [];
      }),
    ),
  ];
  const documents =
    invoiceNumbers.length <= 1
      ? input.documents
      : input.documents.filter((document) => {
          const fields = record(document.extracted_fields);
          const linkedInvoice =
            text(fields.referenceInvoiceNumber) || text(fields.invoiceNumber);
          return identity(linkedInvoice) === expectedInvoice;
        });
  const resolved = await Promise.all(
    RULES.map(async (rule) => ({
      rule,
      fields: await input.getUserFields("OPCH", rule.description),
      candidates: distinctCandidates(documents, rule),
    })),
  );

  return resolved.flatMap(({ rule, fields, candidates }) => {
    if (candidates.length !== 1 || fields.length === 0) return [];
    const candidate = candidates[0]!;
    return fields.flatMap((field) => {
      const fieldName = text(field.Name);
      if (!fieldName) return [];
      const value = sapValue(field, candidate);
      if (value === null) return [];
      const propertyName = `U_${fieldName}`;
      if (sameValue(input.draft[propertyName], value)) return [];
      return [{ description: rule.description, propertyName, value }];
    });
  });
}

export function packetLogisticsUpdatePayload(
  updates: PacketLogisticsUpdate[],
): Record<string, string | number> {
  return Object.fromEntries(
    updates.map((update) => [update.propertyName, update.value]),
  );
}

export function packetLogisticsFieldsMatch(
  document: Record<string, unknown>,
  updates: PacketLogisticsUpdate[],
): boolean {
  return updates.every((update) =>
    sameValue(document[update.propertyName], update.value),
  );
}
