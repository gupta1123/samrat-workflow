import { normalizeSapInspectorRecords } from "@/lib/sap-inspector";
import type { LineResult } from "./types";

export type SupplierOrder = {
  id: string;
  source: "SAP Purchase Orders" | "Open PO report";
  entry: string | null;
  number: string | null;
  reference: string | null;
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
