import { normalizeSapInspectorRecords } from "@/lib/sap-inspector";
import type { LineResult } from "./types";

export type SupplierOrder = {
  id: string;
  source: "SAP Purchase Orders" | "Open PO report";
  entry: string | null;
  number: string | null;
  reference: string | null;
  invoiceNumbers: string[];
  invoiceLookup: "complete" | "partial" | "unavailable";
  date: string | null;
  status: string;
  currency: string | null;
  selectedFor: number[];
  lines: Array<{
    number: string | null;
    item: string | null;
    description: string | null;
    quantity: number | null;
    openQuantity: number | null;
    price: number | null;
  }>;
};

export type SupplierOrdersResponse = {
  vendor: { cardCode: string; cardName: string };
  checkedAt: string;
  orders: SupplierOrder[];
  warnings: string[];
};

export function supplierOrderMatchesInvoice(
  order: SupplierOrder,
  invoiceNumber: string,
) {
  const reference = invoiceNumber.trim().toUpperCase();
  return (
    Boolean(reference) &&
    (order.invoiceNumbers ?? []).some(
      (number) => number.trim().toUpperCase() === reference,
    )
  );
}

/** Exact base links, not a coincidentally matching document number. */
export function selectedOrderEntries(lines: LineResult[]) {
  return [
    ...new Set(
      lines.flatMap((line) =>
        line.candidates
          .filter((candidate) => candidate.allocated > 0)
          .flatMap((candidate) => {
            const entry =
              candidate.kind === "PO"
                ? candidate.docEntry
                : candidate.purchaseOrder?.docEntry;
            return entry != null && Number.isInteger(entry) && entry > 0
              ? [entry]
              : [];
          }),
      ),
    ),
  ];
}

export function supplierOrders(
  rows: Record<string, unknown>[],
  cardCode: string,
  matchLines: LineResult[],
  feed: "service-layer" | "spapi",
): SupplierOrder[] {
  const records = normalizeSapInspectorRecords(
    feed === "spapi" ? "open-po" : "po",
    rows,
    { feed },
  );
  const grouped = new Map<string, SupplierOrder>();
  for (const record of records) {
    // Unknown suppliers never become a supplier-scoped result.
    if (record.vendorCode !== cardCode || record.cancelled) continue;
    const id = `${feed}:${record.docEntry ?? record.docNumber ?? record.id}`;
    const selectedFor =
      feed === "service-layer"
        ? matchLines
            .filter((line) =>
              selectedOrderEntries([line]).some(
                (entry) => String(entry) === record.docEntry,
              ),
            )
            .map((line) => line.index)
        : [];
    const mapped = record.lines.map((line) => {
      const price =
        line.raw.Price == null || line.raw.Price === ""
          ? NaN
          : Number(line.raw.Price);
      return {
        number: line.lineNumber,
        item: line.itemCode,
        description: line.description,
        quantity: line.quantity,
        openQuantity:
          feed === "service-layer" && line.status === "bost_Close"
            ? 0
            : line.openQuantity,
        // Use the same post-discount price the matching engine compares.
        price:
          feed === "service-layer" && Number.isFinite(price)
            ? price
            : line.price,
      };
    });
    const previous = grouped.get(id);
    if (previous) {
      const seen = new Set(previous.lines.map((line) => JSON.stringify(line)));
      previous.lines.push(
        ...mapped.filter((line) => !seen.has(JSON.stringify(line))),
      );
    } else {
      grouped.set(id, {
        id,
        source: feed === "spapi" ? "Open PO report" : "SAP Purchase Orders",
        entry: record.docEntry,
        number: record.docNumber,
        reference: record.vendorReference,
        invoiceNumbers: [],
        invoiceLookup: "unavailable",
        date: record.date,
        status: record.status,
        currency: record.currency,
        selectedFor,
        lines: mapped,
      });
    }
  }
  return [...grouped.values()];
}

/** Join only SAP base-document links; never infer invoices from a PO's NumAtCard. */
export function supplierInvoiceNumbers(
  cardCode: string,
  receipts: Record<string, unknown>[],
  invoices: Record<string, unknown>[],
): Record<string, string[]> {
  const valid = (row: Record<string, unknown>) =>
    row.CardCode === cardCode &&
    (row.Cancelled === "tNO" || row.Cancelled === "N");
  const lines = (row: Record<string, unknown>) =>
    Array.isArray(row.DocumentLines)
      ? (row.DocumentLines as Record<string, unknown>[])
      : [];
  const entry = (value: unknown) => {
    const number = value == null || value === "" ? NaN : Number(value);
    return Number.isInteger(number) && number > 0 ? String(number) : null;
  };
  const poLinks = (row: Record<string, unknown>) => [
    ...new Set(
      lines(row).flatMap((line) => {
        const base = entry(line.BaseEntry);
        return Number(line.BaseType) === 22 && base ? [base] : [];
      }),
    ),
  ];
  const receiptLines = new Map<string, string>();
  const numbersByPo = new Map<string, Set<string>>();
  const add = (row: Record<string, unknown>, links: string[]) => {
    const numbers = [row.U_TATAINV, row.NumAtCard]
      .filter((value) => typeof value === "string" || typeof value === "number")
      .map((value) => String(value).trim())
      .filter((value) => value !== "" && value !== "0");
    for (const link of links) {
      const numbersForPo = numbersByPo.get(link) ?? new Set<string>();
      for (const number of numbers) numbersForPo.add(number);
      numbersByPo.set(link, numbersForPo);
    }
  };
  for (const row of receipts.filter(valid)) {
    const links = poLinks(row);
    const receiptEntry = entry(row.DocEntry);
    if (receiptEntry)
      for (const line of lines(row)) {
        const base = entry(line.BaseEntry);
        const lineNumber = line.LineNum;
        if (Number(line.BaseType) === 22 && base && lineNumber != null) {
          receiptLines.set(`${receiptEntry}:${lineNumber}`, base);
        }
      }
    add(row, links);
  }
  for (const row of invoices.filter(valid)) {
    const links = [
      ...poLinks(row),
      ...lines(row).flatMap((line) => {
        const base = entry(line.BaseEntry);
        const linked =
          base && line.BaseLine != null
            ? receiptLines.get(`${base}:${line.BaseLine}`)
            : null;
        return Number(line.BaseType) === 20 && linked ? [linked] : [];
      }),
    ];
    add(row, links);
  }
  return Object.fromEntries(
    [...numbersByPo].map(([entry, values]) => [
      entry,
      [...values].sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true }),
      ),
    ]),
  );
}

export type SupplierInvoiceReferencesResponse = {
  invoicesByPo: Record<string, string[]>;
  lookup: SupplierOrder["invoiceLookup"];
  warnings: string[];
};

export function withSupplierInvoiceNumbers(
  orders: SupplierOrder[],
  cardCode: string,
  receipts: Record<string, unknown>[],
  invoices: Record<string, unknown>[],
  lookup: SupplierOrder["invoiceLookup"],
): SupplierOrder[] {
  const numbersByPo = supplierInvoiceNumbers(cardCode, receipts, invoices);
  return orders.map((order) => ({
    ...order,
    // SPAPI IDs belong to a separate report and cannot be assumed to be SL IDs.
    invoiceNumbers:
      order.source === "SAP Purchase Orders" && order.entry
        ? (numbersByPo[order.entry] ?? [])
        : [],
    invoiceLookup:
      order.source === "SAP Purchase Orders" ? lookup : "unavailable",
  }));
}
