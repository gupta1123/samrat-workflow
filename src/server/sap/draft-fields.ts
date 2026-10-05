import type {
  DraftFieldChoices,
  DraftHeaderPreview,
} from "@/lib/sap-draft-fields";
import type { MatchInvoice } from "@/lib/sap-match/types";
import { sapInvoiceDate } from "./dates";

export const DRAFT_FIELD_NAMES = [
  "TATAINV",
  "TATAINVDT",
  "TRSPRT",
  "SAMKTW",
  "TATKTW",
  "TOTQTY",
  "MTRFORM",
];
type Document = { document_type?: unknown; extracted_fields?: unknown };
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}
function identity(value: unknown) {
  return text(value).toUpperCase();
}
function useful(value: unknown) {
  return !["", "-", "NA", "N/A", "NONE", "NULL"].includes(identity(value));
}
function unique(values: string[]) {
  return [
    ...new Map(
      values.filter(useful).map((value) => [identity(value), value]),
    ).values(),
  ];
}
function options(field: Record<string, unknown>) {
  const values =
    field.ValidValuesMD ?? field.ValidValues ?? field.ValidValuesCollection;
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    const row = record(value);
    const code = text(row.Value);
    return code ? [{ value: code, label: text(row.Description) || code }] : [];
  });
}
function optionFor(value: string, values: ReturnType<typeof options>) {
  const matches = values.filter(
    (row) =>
      identity(row.value) === identity(value) ||
      identity(row.label) === identity(value),
  );
  return matches.length === 1 ? matches[0].value : "";
}
/** The client's Kata weight fields are in MT. Never infer weight from invoice quantity. */
export function draftWeightTonnes(value: unknown): number | null {
  const match = text(value)
    .replaceAll(",", "")
    .match(
      /^([0-9]+(?:\.[0-9]+)?)\s*(KG|KGS|KILOGRAMS?|MT|MTS|TONS?|TONNES?)$/i,
    );
  if (!match) return null; // An unlabelled number has no reliable weight unit.
  const number = Number(match[1]);
  return number > 0
    ? Number((number / (/^K/i.test(match[2]) ? 1000 : 1)).toFixed(6))
    : null;
}

export function buildDraftHeaderFields(input: {
  invoice: MatchInvoice;
  documents: Document[];
  metadata: Record<string, unknown>[];
  choices?: DraftFieldChoices;
  service: boolean;
}) {
  const fields = new Map(
    DRAFT_FIELD_NAMES.map((name) => {
      const matches = input.metadata.filter(
        (field) => field.Name === name && field.TableName === "OPCH",
      );
      if (matches.length !== 1)
        throw new Error(
          `SAP did not expose one ${name} field for the A/P Invoice Draft.`,
        );
      return [name, matches[0]] as const;
    }),
  );
  const invoiceDocuments = input.documents.filter((doc) =>
    ["Invoice", "Tax Invoice"].includes(text(doc.document_type)),
  );
  const primary = invoiceDocuments.filter(
    (doc) =>
      identity(record(doc.extracted_fields).invoiceNumber) ===
      identity(input.invoice.invoiceNumber),
  );
  if (!primary.length || !input.invoice.invoiceDate)
    throw new Error(
      "The scanned invoice number and document date are required before creating a draft.",
    );
  const invoiceNumbers = unique(
    invoiceDocuments.map((doc) =>
      text(record(doc.extracted_fields).invoiceNumber),
    ),
  );
  const linked = input.documents.filter((doc) => {
    const data = record(doc.extracted_fields);
    if (["Invoice", "Tax Invoice"].includes(text(doc.document_type)))
      return primary.includes(doc);
    const reference =
      text(data.referenceInvoiceNumber) || text(data.invoiceNumber);
    return reference
      ? identity(reference) === identity(input.invoice.invoiceNumber)
      : invoiceNumbers.length === 1;
  });
  const candidates = (documents: Document[], key: string) =>
    unique(documents.map((doc) => text(record(doc.extracted_fields)[key])));
  const dates = unique(
    primary.map(
      (doc) => sapInvoiceDate(record(doc.extracted_fields).documentDate) ?? "",
    ),
  );
  if (dates.length !== 1 || dates[0] !== input.invoice.invoiceDate)
    throw new Error(
      "The invoice document date is missing or conflicting. Review it before creating a draft.",
    );
  const warnings: string[] = [];
  const values: Record<string, string | number | null> = {};
  const preview: DraftHeaderPreview["fields"] = [];
  const put = (
    name: string,
    label: string,
    value: string | number | null,
    source: string,
  ) => {
    if (value !== null) {
      const metadata = fields.get(name)!;
      const type = text(metadata.Type);
      let typed: string | number =
        type === "db_Alpha" || type === "db_Date" ? String(value) : value;
      if (["db_Numeric", "db_Float"].includes(type)) {
        if (!/^\d+(?:\.\d+)?$/.test(String(value)))
          throw new Error(`${label} is incompatible with SAP's numeric field.`);
        typed = Number(value);
        if (
          !Number.isFinite(typed) ||
          (type === "db_Numeric" && !Number.isSafeInteger(typed))
        )
          throw new Error(`${label} exceeds SAP's numeric field.`);
      }
      const size = Number(metadata.EditSize ?? metadata.Size);
      if (type === "db_Alpha" && size > 0 && String(typed).length > size)
        throw new Error(`${label} exceeds SAP's ${size}-character limit.`);
      values[`U_${name}`] = typed;
    } else values[`U_${name}`] = null; // Explicitly clear unavailable PDF values instead of copying GRPO UDFs.
    preview.push({
      key: `U_${name}`,
      label,
      value: values[`U_${name}`] ?? null,
      source,
    });
  };
  put(
    "TATAINV",
    "Supplier invoice number",
    input.invoice.invoiceNumber,
    "Scanned invoice",
  );
  put(
    "TATAINVDT",
    "Supplier invoice date",
    input.invoice.invoiceDate,
    "Scanned invoice",
  );

  const choose = (
    name: "TRSPRT" | "MTRFORM",
    raw: string[],
    selected: string | undefined,
    label: string,
  ) => {
    const allowed = options(fields.get(name)!);
    if (!allowed.length)
      throw new Error(`SAP did not provide allowed ${label} choices.`);
    if (selected && !allowed.some((row) => row.value === selected))
      throw new Error(`The selected ${label} is not allowed by SAP.`);
    const mapped = raw.length === 1 ? optionFor(raw[0], allowed) : "";
    if (raw.length && !mapped)
      warnings.push(
        `${label} from the PDF ${raw.join(", ")} needs a valid SAP selection.`,
      );
    const value = selected || mapped;
    put(
      name,
      label,
      value || null,
      selected
        ? "Selected for this draft"
        : value
          ? "Scanned packet"
          : "Selection required",
    );
    return { selectedValue: value, options: allowed };
  };
  const transporter = choose(
    "TRSPRT",
    candidates(linked, "transporterName"),
    input.choices?.transporter,
    "Transporter",
  );
  const materialCandidates = unique(
    primary.flatMap((doc) => {
      const data = record(doc.extracted_fields);
      return [text(data.materialForm), text(data.materialType)];
    }),
  );
  const materialForm = choose(
    "MTRFORM",
    materialCandidates,
    input.choices?.materialForm || (input.service ? "ST" : undefined),
    "Material Form",
  );

  const weight = (
    documents: Document[],
    name: string,
    label: string,
    source: string,
  ) => {
    const raw = candidates(documents, "netWeight");
    const parsed = raw.map(draftWeightTonnes);
    const distinct = [
      ...new Set(parsed.filter((value): value is number => value !== null)),
    ];
    const value =
      distinct.length === 1 && parsed.every((value) => value !== null)
        ? distinct[0]
        : null;
    if (raw.length && value === null)
      warnings.push(
        `${label} has conflicting values or an unsupported weight unit in the PDF.`,
      );
    put(
      name,
      `${label} (MT)`,
      value,
      value === null ? "Not recorded in PDF" : source,
    );
  };
  weight(
    primary,
    "TATKTW",
    "Supplier Kata Weight",
    "Scanned invoice net weight",
  );
  weight(
    linked.filter((doc) => doc.document_type === "Weighment Slip"),
    "SAMKTW",
    "Samrat Kata Weight",
    "Weighment slip net weight",
  );
  const units = unique(input.invoice.lines.map((line) => text(line.unit)));
  const quantities = input.invoice.lines.map((line) => line.quantity);
  const complete =
    units.length === 1 &&
    input.invoice.lines.every(
      (line) =>
        useful(line.unit) && line.quantity !== null && line.quantity > 0,
    );
  const total = complete
    ? Number(
        quantities
          .reduce<number>((sum, value) => sum + (value ?? 0), 0)
          .toFixed(6),
      )
    : null;
  if (!complete && !input.service)
    warnings.push(
      "Total invoice quantity cannot be summed because units or quantities are missing or mixed.",
    );
  put(
    "TOTQTY",
    `Total invoice quantity${units.length === 1 ? ` (${units[0]})` : ""}`,
    total,
    total === null ? "Not recorded in PDF" : "Scanned invoice lines",
  );
  return {
    values,
    preview: {
      fields: preview,
      transporter,
      materialForm,
      warnings,
    } satisfies DraftHeaderPreview,
  };
}
