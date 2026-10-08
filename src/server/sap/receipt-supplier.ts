import type {
  MatchInvoice,
  SupplierIdentification,
} from "@/lib/sap-match/types";
import type { SapFieldConfig } from "./match-mapping";
import type { SapMatchDocument, SapSupplierRow } from "./service-layer";

/** Only authoritative, literal shipment references can establish a supplier.
 * Names, quantities, prices and vehicles are never identity evidence here.
 */
export function resolveReceiptSupplier(
  invoice: Pick<MatchInvoice, "invoiceNumber" | "eWayBill" | "vendorGstin">,
  documents: SapMatchDocument[],
  suppliers: SapSupplierRow[],
  config: SapFieldConfig,
) {
  const exact = (actual: unknown, expected: string | null) =>
    typeof actual === "string" &&
    Boolean(expected?.trim()) &&
    actual.trim() === expected?.trim();
  const evidence: NonNullable<SupplierIdentification["receiptEvidence"]> = [];
  for (const document of documents) {
    if (
      document.DocumentStatus !== "bost_Open" ||
      document.Cancelled !== "tNO" ||
      typeof document.DocEntry !== "number" ||
      typeof document.DocNum !== "number" ||
      !document.CardCode ||
      !(document.DocumentLines ?? []).some(
        (line) =>
          line.LineStatus === "bost_Open" &&
          typeof line.RemainingOpenQuantity === "number" &&
          line.RemainingOpenQuantity > 0,
      )
    )
      continue;
    const references = [
      {
        field: "Invoice No.",
        value: invoice.invoiceNumber,
        matches:
          exact(document.NumAtCard, invoice.invoiceNumber) ||
          Boolean(
            config.invoiceRefField &&
            exact(document[config.invoiceRefField], invoice.invoiceNumber),
          ),
      },
      {
        field: "E-Way Bill No.",
        value: invoice.eWayBill,
        matches:
          invoice.eWayBill?.trim() !== "0" &&
          Boolean(
            config.eWayBillField &&
            exact(document[config.eWayBillField], invoice.eWayBill),
          ),
      },
    ];
    for (const reference of references) {
      if (reference.matches && reference.value)
        evidence.push({
          docEntry: document.DocEntry,
          docNum: document.DocNum,
          cardCode: document.CardCode,
          field: reference.field,
          value: reference.value,
        });
    }
  }
  const codes = new Set(evidence.map((entry) => entry.cardCode));
  const candidates = suppliers.filter((supplier) =>
    codes.has(supplier.CardCode),
  );
  const ambiguous = candidates.map((supplier) => ({
    cardCode: supplier.CardCode,
    cardName: supplier.CardName,
    why: "Exact invoice or e-way bill reference on an open SAP GRPO",
  }));
  // Missing BP records or conflicting references must never be treated as a
  // unique match. An extracted GSTIN is a constraint, not something to overwrite.
  const supplier =
    codes.size === 1 && candidates.length === 1 ? candidates[0] : null;
  const sapGstins = [
    ...new Set(
      (supplier?.BPAddresses ?? [])
        .map((address) => address.GSTIN?.trim().toUpperCase())
        .filter((gstin): gstin is string => Boolean(gstin)),
    ),
  ];
  const gstin = invoice.vendorGstin?.trim().toUpperCase();
  if (!supplier || (gstin && !sapGstins.includes(gstin))) {
    return { vendor: null, ambiguous, identification: null };
  }
  return {
    vendor: { cardCode: supplier.CardCode, cardName: supplier.CardName },
    ambiguous: [],
    identification: {
      method: "receipt-reference" as const,
      sapGstins,
      receiptEvidence: evidence,
    },
  };
}
