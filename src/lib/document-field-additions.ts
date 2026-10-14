import type { DocType, FieldKey } from "@/types/pipeline";

// One taxonomy shared by the extractor, settings and the extracted-data view.
// No source values are populated by these field definitions.
export const SOURCE_FIELD_ADDITIONS: Partial<Record<DocType, FieldKey[]>> = {
  Invoice: [
    "paymentTerms",
    "materialValue",
    "totalTaxableAmount",
    "cgstAmount",
    "sgstAmount",
    "igstAmount",
  ],
  "Tax Invoice": [
    "paymentTerms",
    "materialValue",
    "totalTaxableAmount",
    "cgstAmount",
    "sgstAmount",
    "igstAmount",
  ],
  "Purchase Order": [
    "cgstAmount",
    "sgstAmount",
    "igstAmount",
    "totalTaxableAmount",
  ],
  "Amended Purchase Order": [
    "cgstAmount",
    "sgstAmount",
    "igstAmount",
    "totalTaxableAmount",
  ],
  "E-Way Bill": [
    "goodsValue",
    "cgstAmount",
    "sgstAmount",
    "igstAmount",
    "itemDescription",
    "itemQuantity",
    "unit",
    "hsnSac",
  ],
  "Lorry Receipt": [
    "deliveryOrderNumber",
    "itemDescription",
    "itemQuantity",
    "unit",
  ],
  "Weighment Slip": ["buyerName", "itemDescription", "itemQuantity", "unit"],
  "Material Test Certificate": [
    "bisLicenseNumber",
    "certificateDate",
    "documentDate",
    "buyerName",
    "itemDescription",
    "materialGrade",
  ],
};

export function extendSourceFields(fields: Record<DocType, FieldKey[]>) {
  for (const [docType, additions] of Object.entries(SOURCE_FIELD_ADDITIONS)) {
    fields[docType as DocType] = [
      ...new Set([...fields[docType as DocType], ...additions]),
    ];
  }
}
