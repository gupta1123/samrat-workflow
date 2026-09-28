import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaseDoc } from "../src/types/pipeline";
import { verifyProcessedDocuments } from "../src/server/processing/pipeline";

function document(
  id: string,
  type: CaseDoc["type"],
  vehicleNumber: string,
): CaseDoc {
  return {
    id,
    type,
    title: type,
    pages: 1,
    fields: {
      invoiceNumber: type === "Tax Invoice" ? "AVS/26-27/1842" : undefined,
      referenceInvoiceNumber:
        type === "Tax Invoice" ? undefined : "AVS/26-27/1842",
      referencePoNumber: "SI/PO/26-27/778",
      vehicleNumber,
      vendorName: "Aavishkar Steel Processing Private Limited",
      buyerName: "Samrat Irons Private Limited",
      subtotal: "1020000.00",
      taxAmount: "183600.00",
      totalAmount: "1203600.00",
      taxRate: "18",
    },
    md:
      `Invoice AVS/26-27/1842\nVehicle No ${vehicleNumber}\n` +
      "Taxable Value 1020000.00\nIGST 183600.00\nTotal 1203600.00",
  };
}

test("a vehicle conflict stays a vehicle mismatch when all tax evidence agrees", () => {
  const result = verifyProcessedDocuments(
    [
      document("invoice", "Tax Invoice", "MH12AB4387"),
      document("eway", "E-Way Bill", "MH12AB4382"),
      document("lorry", "Lorry Receipt", "MH12AB4387"),
      document("weighment", "Weighment Slip", "MH12AB4387"),
    ],
    { considerFormatting: false },
  );

  assert.ok(
    result.mismatches.some((mismatch) => mismatch.field === "vehicleNumber"),
  );
  assert.equal(
    result.mismatches.some((mismatch) =>
      ["taxRate", "taxAmount", "subtotal", "totalAmount"].includes(
        mismatch.field,
      ),
    ),
    false,
  );
});
