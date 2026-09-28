type SapDocument = Record<string, unknown>;

type LearnedFieldSource = "invoiceNumber" | "invoiceDate" | "lineQuantity";

export type LearnedSapFieldUpdate = {
  propertyName: string;
  source: LearnedFieldSource;
  evidenceCount: number;
  value: string | number;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function dateOnly(value: unknown): string {
  const valueText = text(value);
  return valueText.length >= 10 ? valueText.slice(0, 10) : "";
}

function finiteNumber(value: unknown): number | null {
  const parsed =
    typeof value === "string"
      ? Number(value.replaceAll(",", "").trim())
      : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function documentLines(document: SapDocument): Record<string, unknown>[] {
  return Array.isArray(document.DocumentLines)
    ? document.DocumentLines.map(record)
    : [];
}

function quantityEvidence(document: SapDocument): {
  quantity: number;
  unit: string;
} | null {
  const lines = documentLines(document);
  if (lines.length === 0) return null;

  const units = [
    ...new Set(
      lines
        .map(
          (line) =>
            text(line.MeasureUnit) || text(line.UnitsOfMeasurment),
        )
        .filter(Boolean),
    ),
  ];
  if (units.length !== 1 || !units[0]) return null;

  const quantities = lines.map((line) => finiteNumber(line.Quantity));
  if (quantities.some((quantity) => quantity === null)) return null;
  const quantity = quantities.reduce<number>(
    (sum, value) => sum + (value ?? 0),
    0,
  );
  return quantity > 0 ? { quantity, unit: units[0] } : null;
}

function userFieldNames(documents: SapDocument[]): string[] {
  return [
    ...new Set(
      documents.flatMap((document) =>
        Object.keys(document).filter((key) => key.startsWith("U_")),
      ),
    ),
  ];
}

function numbersMatch(left: unknown, right: number): boolean {
  const parsed = finiteNumber(left);
  return parsed !== null && Math.abs(parsed - right) <= 0.000001;
}

function updateValueLikeEvidence(
  evidenceValue: unknown,
  sourceValue: string | number,
): string | number {
  return typeof evidenceValue === "number"
    ? Number(sourceValue)
    : String(sourceValue);
}

/**
 * Learn a vendor's custom AP-invoice fields from its own successful SAP
 * invoices. A field is usable only when at least two independent invoices
 * show the same exact relationship to a standard invoice value. Field names,
 * vendor names, and business-specific prefixes are never guessed.
 */
export function learnVendorInvoiceFieldUpdates(input: {
  draft: SapDocument;
  historicalInvoices: SapDocument[];
}): LearnedSapFieldUpdate[] {
  const history = input.historicalInvoices;
  if (history.length < 2) return [];

  const fields = userFieldNames(history);
  const updates: LearnedSapFieldUpdate[] = [];

  const draftInvoiceNumber = text(input.draft.NumAtCard);
  if (draftInvoiceNumber) {
    const evidence = history.filter((invoice) => text(invoice.NumAtCard));
    if (evidence.length >= 2) {
      for (const propertyName of fields) {
        if (
          evidence.every(
            (invoice) =>
              text(invoice[propertyName]) === text(invoice.NumAtCard),
          )
        ) {
          updates.push({
            propertyName,
            source: "invoiceNumber",
            evidenceCount: evidence.length,
            value: updateValueLikeEvidence(
              evidence[0]?.[propertyName],
              draftInvoiceNumber,
            ),
          });
        }
      }
    }
  }

  const draftInvoiceDate = dateOnly(input.draft.TaxDate);
  if (draftInvoiceDate) {
    const evidence = history.filter((invoice) => dateOnly(invoice.TaxDate));
    if (evidence.length >= 2) {
      for (const propertyName of fields) {
        if (
          evidence.every(
            (invoice) =>
              dateOnly(invoice[propertyName]) === dateOnly(invoice.TaxDate),
          )
        ) {
          updates.push({
            propertyName,
            source: "invoiceDate",
            evidenceCount: evidence.length,
            value: updateValueLikeEvidence(
              evidence[0]?.[propertyName],
              draftInvoiceDate,
            ),
          });
        }
      }
    }
  }

  const draftQuantity = quantityEvidence(input.draft);
  if (draftQuantity) {
    const evidence = history.filter((invoice) => {
      const quantity = quantityEvidence(invoice);
      return quantity?.unit === draftQuantity.unit;
    });
    if (evidence.length >= 2) {
      for (const propertyName of fields) {
        if (
          evidence.every((invoice) => {
            const quantity = quantityEvidence(invoice);
            return (
              quantity !== null &&
              numbersMatch(invoice[propertyName], quantity.quantity)
            );
          })
        ) {
          updates.push({
            propertyName,
            source: "lineQuantity",
            evidenceCount: evidence.length,
            value: updateValueLikeEvidence(
              evidence[0]?.[propertyName],
              draftQuantity.quantity,
            ),
          });
        }
      }
    }
  }

  return updates;
}

export function learnedFieldUpdatePayload(
  updates: LearnedSapFieldUpdate[],
): Record<string, string | number> {
  return Object.fromEntries(
    updates.map((update) => [update.propertyName, update.value]),
  );
}

export function learnedFieldsMatch(
  document: SapDocument,
  updates: LearnedSapFieldUpdate[],
): boolean {
  return updates.every((update) => {
    const actual = document[update.propertyName];
    if (update.source === "invoiceDate") {
      return dateOnly(actual) === dateOnly(update.value);
    }
    if (update.source === "lineQuantity") {
      return numbersMatch(actual, Number(update.value));
    }
    return text(actual) === text(update.value);
  });
}
