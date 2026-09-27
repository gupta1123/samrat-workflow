import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePacketIntelligence,
  type PacketIntelligence,
} from "../src/lib/packet-intelligence";

function invoice(params: {
  id: string;
  invoiceNumber: string;
  buyerName?: string;
  supplierName?: string;
  totalAmount?: string;
  title?: string;
  markdown?: string;
}) {
  return {
    id: `stored-${params.id}`,
    clientDocumentId: params.id,
    documentType: "Tax Invoice",
    title: params.title ?? "Tax Invoice",
    sourceFileName: `${params.id}.pdf`,
    extractedFields: {
      invoiceNumber: params.invoiceNumber,
      buyerName: params.buyerName ?? "Samrat Group",
      vendorName: params.supplierName ?? "Example Supplier",
      totalAmount: params.totalAmount ?? "118000",
    },
    markdown: params.markdown ?? "",
  };
}

function check(
  intelligence: PacketIntelligence,
  key: string,
): PacketIntelligence["checks"][number] {
  const result = intelligence.checks.find((entry) => entry.key === key);
  assert.ok(result, `Missing ${key} intelligence check`);
  return result;
}

test("one invoice is treated as a normal shipment", () => {
  const result = resolvePacketIntelligence({
    documents: [invoice({ id: "invoice", invoiceNumber: "INV-001" })],
    processingMeta: { uploadFingerprint: "a".repeat(64) },
  });

  assert.equal(result.kind, "single_shipment");
  assert.equal(result.confidence, "high");
  assert.equal(check(result, "shipment_grouping").status, "clear");
  assert.deepEqual(result.primaryDocumentIds, ["invoice"]);
});

test("invoice copies collapse into one evidence source", () => {
  const result = resolvePacketIntelligence({
    documents: [
      invoice({
        id: "original",
        invoiceNumber: "INV-002",
        title: "Original for recipient",
      }),
      invoice({
        id: "transporter",
        invoiceNumber: "INV-002",
        title: "Duplicate copy for transporter",
      }),
    ],
  });

  assert.equal(result.kind, "duplicate_document_copies");
  assert.equal(result.collapsedCopyGroups.length, 1);
  assert.equal(result.collapsedCopyGroups[0]?.keptDocumentId, "original");
  assert.ok(result.contextDocumentIds.includes("transporter"));
});

test("duplicate packet fingerprint takes precedence over document grouping", () => {
  const result = resolvePacketIntelligence({
    documents: [invoice({ id: "invoice", invoiceNumber: "INV-003" })],
    duplicateCases: [
      {
        id: "case-existing",
        displayName: "Existing packet",
        status: "completed",
        createdAt: "2026-08-31T09:00:00.000Z",
      },
    ],
  });

  assert.equal(result.kind, "duplicate_upload");
  assert.equal(result.tone, "danger");
  assert.equal(check(result, "duplicate_upload").status, "blocked");
  assert.equal(result.duplicateCases[0]?.id, "case-existing");
});

test("seller-chain intelligence follows verification roles without client-specific names", () => {
  const result = resolvePacketIntelligence({
    documents: [
      invoice({
        id: "buyer-facing",
        invoiceNumber: "SG-101",
        buyerName: "Samrat Group",
        supplierName: "Distributor One",
      }),
      invoice({
        id: "upstream",
        invoiceNumber: "UP-44",
        buyerName: "Distributor One",
        supplierName: "Manufacturer Two",
      }),
    ],
    verificationGroups: [
      {
        roleSelection: {
          strategy: "seller_chain",
          primaryDocumentIds: ["buyer-facing"],
          contextDocumentIds: ["upstream"],
        },
      },
    ],
  });

  assert.equal(result.kind, "seller_chain");
  assert.equal(result.label, "Mother bill chain");
  assert.ok(result.primaryDocumentIds.includes("buyer-facing"));
  assert.ok(result.contextDocumentIds.includes("upstream"));
  assert.match(result.summary, /buyer-facing invoice/i);
  assert.match(result.summary, /mother bill/i);
  assert.equal(check(result, "shipment_grouping").status, "clear");
  assert.match(check(result, "shipment_grouping").detail, /linked/i);
  assert.doesNotMatch(JSON.stringify(result), /kalika/i);
});

test("separate buyers in one upload are marked for splitting", () => {
  const result = resolvePacketIntelligence({
    documents: [
      invoice({
        id: "one",
        invoiceNumber: "INV-101",
        buyerName: "Buyer One",
      }),
      invoice({
        id: "two",
        invoiceNumber: "INV-202",
        buyerName: "Buyer Two",
      }),
    ],
  });

  assert.equal(result.kind, "multi_shipment_different_companies");
  assert.equal(result.tone, "danger");
  assert.ok(
    result.shipmentGroups.every((group) => group.role === "split_candidate"),
  );
});

test("tax and terms issues are surfaced as packet checks", () => {
  const result = resolvePacketIntelligence({
    documents: [invoice({ id: "invoice", invoiceNumber: "INV-401" })],
    mismatches: [
      {
        fieldName: "taxAmount",
        values: [{ docId: "invoice", value: "18000" }],
      },
      {
        fieldName: "termsAndConditions",
        values: [{ docId: "po", value: "Not fulfilled" }],
      },
    ],
  });

  const taxTerms = check(result, "tax_terms");
  assert.equal(taxTerms.status, "attention");
  assert.match(taxTerms.detail, /tax calculation and terms-compliance/i);
});
