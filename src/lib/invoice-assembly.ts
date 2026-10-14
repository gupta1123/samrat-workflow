import type { CaseDoc, CommercialLineItem, FieldKey } from "@/types/pipeline";
import { SOURCE_LINE_ITEM_KEYS } from "./source-line-items";

export type InvoiceAssembly = {
  invoiceNumber: string;
  fieldSources: Array<{ field: FieldKey; docId: string }>;
  documents: Array<{
    docId: string;
    role: "header" | "billing" | "duplicate";
    duplicateOfDocId: string | null;
  }>;
  reason: string;
};
export type AssemblyDocument = Pick<
  CaseDoc,
  | "id"
  | "type"
  | "fields"
  | "lineItems"
  | "tableCoverage"
  | "supplyNature"
  | "sourceFileName"
  | "sourcePageNumbers"
>;
export function invoiceAssemblySchema(fields: readonly string[]) {
  const text = { type: "string" };
  return {
    type: "array",
    items: {
      type: "object",
      properties: {
        invoiceNumber: text,
        reason: text,
        fieldSources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string", enum: [...fields] },
              docId: text,
            },
            required: ["field", "docId"],
            additionalProperties: false,
          },
        },
        documents: {
          type: "array",
          items: {
            type: "object",
            properties: {
              docId: text,
              role: {
                type: "string",
                enum: ["header", "billing", "duplicate"],
              },
              duplicateOfDocId: { type: ["string", "null"] },
            },
            required: ["docId", "role", "duplicateOfDocId"],
            additionalProperties: false,
          },
        },
      },
      required: ["invoiceNumber", "fieldSources", "documents", "reason"],
      additionalProperties: false,
    },
  };
}
const invoiceTypes = new Set(["Invoice", "Tax Invoice"]);
const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid invoice assembly object.");
  return value as Record<string, unknown>;
};
function sameRows(a: CommercialLineItem[], b: CommercialLineItem[]) {
  const cells = (rows: CommercialLineItem[]) =>
    rows.map((row) =>
      SOURCE_LINE_ITEM_KEYS.filter(
        (key) => key !== "sourcePage" && key !== "rawText",
      ).map((key) => row[key] ?? null),
    );
  return a.length > 0 && JSON.stringify(cells(a)) === JSON.stringify(cells(b));
}

/** Validate semantic page/role decisions against retained source observations.
 * This never decides relationships from names, filenames, position or scores. */
export function parseInvoiceAssemblies(
  raw: unknown,
  documents: AssemblyDocument[],
  allowedFields: readonly string[],
  unverifiedIds: ReadonlySet<string> = new Set(),
): InvoiceAssembly[] {
  if (raw === undefined) return []; // Old single-document contracts remain readable.
  if (!Array.isArray(raw))
    throw new Error("Invoice assemblies must be an array.");
  const byId = new Map(documents.map((doc) => [doc.id, doc]));
  const assigned = new Set<string>();
  return raw.map((value) => {
    const entry = obj(value);
    if (
      Object.keys(entry).some(
        (key) =>
          !["invoiceNumber", "fieldSources", "documents", "reason"].includes(
            key,
          ),
      ) ||
      typeof entry.invoiceNumber !== "string" ||
      !entry.invoiceNumber.trim() ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim() ||
      !Array.isArray(entry.documents) ||
      !entry.documents.length ||
      !Array.isArray(entry.fieldSources)
    )
      throw new Error(
        "Invoice assembly needs explicit identity, document roles and field sources.",
      );
    const members = entry.documents.map((value) => {
      const member = obj(value);
      const doc = byId.get(String(member.docId));
      if (
        Object.keys(member).some(
          (key) => !["docId", "role", "duplicateOfDocId"].includes(key),
        ) ||
        !doc ||
        !invoiceTypes.has(doc.type) ||
        assigned.has(doc.id) ||
        unverifiedIds.has(doc.id) ||
        !["header", "billing", "duplicate"].includes(String(member.role))
      )
        throw new Error(
          "Invoice assembly refers to an unknown, repeated or unverified invoice page.",
        );
      const number = doc.fields.invoiceNumber;
      if (number && number.trim() !== entry.invoiceNumber)
        throw new Error(
          "Invoice assembly combines different printed invoice numbers.",
        );
      const rows = doc.lineItems ?? [];
      if (member.role === "header") {
        if (rows.length || doc.tableCoverage?.status !== "not_present")
          throw new Error(
            "A header-only page cannot hide invoice billing rows or an unverified table.",
          );
      } else if (
        doc.tableCoverage?.status !== "complete" ||
        doc.tableCoverage.rows.length !== rows.length ||
        !rows.length
      )
        throw new Error(
          "Every invoice billing page needs complete verified row coverage.",
        );
      if (member.role !== "duplicate" && member.duplicateOfDocId !== null)
        throw new Error("Only a duplicate copy can name a duplicate source.");
      assigned.add(doc.id);
      return {
        docId: doc.id,
        role: member.role as InvoiceAssembly["documents"][number]["role"],
        duplicateOfDocId:
          member.role === "duplicate" ? String(member.duplicateOfDocId) : null,
      };
    });
    for (const member of members.filter(
      (member) => member.role === "duplicate",
    )) {
      const original = members.find(
        (candidate) =>
          candidate.docId === member.duplicateOfDocId &&
          candidate.role === "billing",
      );
      if (
        !original ||
        !sameRows(
          byId.get(member.docId)!.lineItems ?? [],
          byId.get(original.docId)!.lineItems ?? [],
        )
      )
        throw new Error(
        "An excluded duplicate must reproduce an included billing table exactly.",
        );
    }
    const selected = new Set<string>();
    const fieldSources = entry.fieldSources.map((value) => {
      const source = obj(value);
      const doc = byId.get(String(source.docId));
      const field = String(source.field);
      if (
        Object.keys(source).some((key) => !["field", "docId"].includes(key)) ||
        !allowedFields.includes(field) ||
        selected.has(field) ||
        !doc ||
        !members.some((member) => member.docId === doc.id) ||
        !doc.fields[field as FieldKey]?.trim()
      )
        throw new Error(
          "Invoice header field sources must name unique retained values on member pages.",
        );
      selected.add(field);
      return { field: field as FieldKey, docId: doc.id };
    });
    const numberSource = fieldSources.find(
      (source) => source.field === "invoiceNumber",
    );
    if (
      !numberSource ||
      byId.get(numberSource.docId)!.fields.invoiceNumber?.trim() !==
        entry.invoiceNumber
    )
      throw new Error(
        "Invoice identity needs its printed invoice-number source.",
      );
    // Safety checks for identity-bearing values; the reviewer may not silently
    // resolve a conflict by dropping the other document's value.
    for (const field of [
      "supplierGstin",
      "currency",
      "buyerGstin",
      "shipToGstin",
    ] as const) {
      const values = new Set(
        members.flatMap((member) => {
          const value = byId
            .get(member.docId)!
            .fields[field]?.trim()
            .toUpperCase();
          return value ? [value] : [];
        }),
      );
      if (values.size > 1)
        throw new Error(
          `Invoice pages have conflicting ${field}; source review is required.`,
        );
      if (values.size && !selected.has(field))
        throw new Error(
          `Invoice assembly omitted the retained ${field} source.`,
        );
    }
    const kinds = new Set(
      members.flatMap((member) => {
        const kind = byId.get(member.docId)!.supplyNature?.kind;
        return kind && kind !== "unknown" ? [kind] : [];
      }),
    );
    if (kinds.size > 1)
      throw new Error("Invoice pages have conflicting supply classifications.");
    return {
      invoiceNumber: entry.invoiceNumber,
      fieldSources,
      documents: members,
      reason: entry.reason,
    };
  });
}

export function assembledInvoice(
  assembly: InvoiceAssembly,
  documents: AssemblyDocument[],
) {
  const byId = new Map(documents.map((doc) => [doc.id, doc]));
  const fields = Object.fromEntries(
    assembly.fieldSources.map((source) => [
      source.field,
      byId.get(source.docId)!.fields[source.field],
    ]),
  ) as CaseDoc["fields"];
  const rows = assembly.documents
    .filter((member) => member.role === "billing")
    .flatMap((member) =>
      (byId.get(member.docId)!.lineItems ?? []).map((row) => ({
        row,
        doc: byId.get(member.docId)!,
      })),
    );
  const source = byId.get(
    assembly.fieldSources.find((source) => source.field === "invoiceNumber")!
      .docId,
  )!;
  const nature = assembly.documents
    .map((member) => byId.get(member.docId)!.supplyNature)
    .find((nature) => nature && nature.kind !== "unknown");
  return { fields, rows, source, nature };
}
