import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readSupplyNature,
  packetLogisticsRequirement,
  type LogisticsRequirement,
} from "../src/lib/supply-nature";
import {
  getMissingCorePacketDocumentGroups,
  getUnverifiedLogisticsDocumentGroups,
} from "../src/server/case-summary";
import { buildDocumentRequirementReviewIssues } from "../src/lib/missing-documents";
import { serializeFieldsWithLineItems } from "../src/server/line-items";
import { storedSupplyNature } from "../src/lib/supply-nature";
import type { CaseDoc } from "../src/types/pipeline";

function document(
  transport: LogisticsRequirement["status"],
  weightProof: LogisticsRequirement["status"],
  quote = "Count-based replacement component, 1 NOS",
): CaseDoc {
  const assessment = (
    status: LogisticsRequirement["status"],
  ): LogisticsRequirement => ({
    status,
    reason: "Source scope and receipt basis reviewed independently.",
    evidence: [{ sourcePage: 1, quote }],
  });
  return {
    id: "invoice",
    type: "Tax Invoice",
    title: "Invoice",
    pages: 1,
    fields: {},
    md: quote,
    supplyNature: {
      kind: "goods",
      evidence: [{ sourcePage: 1, quote }],
      logisticsRequirements: {
        transport: assessment(transport),
        weightProof: assessment(weightProof),
      },
    },
  };
}

test("source-backed count-based goods do not require weight proof merely because they are goods", () => {
  const doc = document("unknown", "not_applicable");
  assert.deepEqual(getMissingCorePacketDocumentGroups([doc]), []);
  assert.deepEqual(getUnverifiedLogisticsDocumentGroups([doc]), [
    "Transport Document",
  ]);
  const issues = buildDocumentRequirementReviewIssues(
    getUnverifiedLogisticsDocumentGroups([doc]),
  );
  assert.equal(issues[0].field, "documentRequirements");
  assert.ok(issues[0].analysis?.includes("not been declared missing"));
});

test("transport and weight requirements are independent", () => {
  assert.deepEqual(
    getMissingCorePacketDocumentGroups([
      document("required", "not_applicable"),
    ]),
    ["Transport Document"],
  );
  assert.deepEqual(
    getMissingCorePacketDocumentGroups([
      document("not_applicable", "required"),
    ]),
    ["Weight Proof"],
  );
  assert.deepEqual(
    getMissingCorePacketDocumentGroups([
      document("not_applicable", "not_applicable"),
    ]),
    [],
  );
});

test("bulk materials keep both source-backed requirements", () => {
  const doc = document(
    "required",
    "required",
    "Bulk material, received and settled by net weighbridge weight; LR required",
  );
  assert.deepEqual(getMissingCorePacketDocumentGroups([doc]), [
    "Transport Document",
    "Weight Proof",
  ]);
  assert.deepEqual(getUnverifiedLogisticsDocumentGroups([doc]), []);
});

test("explicit PO obligations override invoice exemptions", () => {
  const invoice = document("not_applicable", "not_applicable");
  const po = {
    ...document(
      "required",
      "required",
      "Transport receipt and weighment certificate required",
    ),
    id: "po",
    type: "Purchase Order" as const,
  };
  assert.deepEqual(getMissingCorePacketDocumentGroups([invoice, po]), [
    "Transport Document",
    "Weight Proof",
  ]);
});

test("uncertainty on a second source cannot silently exempt goods", () => {
  const invoice = document("not_applicable", "not_applicable");
  const po = {
    ...document("unknown", "unknown"),
    id: "po",
    type: "Purchase Order" as const,
  };
  assert.deepEqual(getMissingCorePacketDocumentGroups([invoice, po]), []);
  assert.deepEqual(getUnverifiedLogisticsDocumentGroups([invoice, po]), [
    "Transport Document",
    "Weight Proof",
  ]);
});

test("provided logistics documents satisfy their requirements and do not create uncertainty warnings", () => {
  const doc = document("unknown", "required");
  const support = (type: CaseDoc["type"]): CaseDoc => ({
    id: type,
    type,
    title: type,
    pages: 1,
    fields: {},
    md: "",
  });
  assert.deepEqual(
    getMissingCorePacketDocumentGroups([doc, support("Weighment Slip")]),
    [],
  );
  assert.deepEqual(
    getUnverifiedLogisticsDocumentGroups([doc, support("Lorry Receipt")]),
    [],
  );
});

test("legacy material requirements and service exemptions are preserved", () => {
  const doc = document("not_applicable", "not_applicable");
  delete doc.supplyNature!.logisticsRequirements;
  assert.deepEqual(getMissingCorePacketDocumentGroups([doc]), [
    "Transport Document",
    "Weight Proof",
  ]);
  doc.supplyNature!.kind = "services";
  assert.deepEqual(getMissingCorePacketDocumentGroups([doc]), []);
});

test("assessments survive existing JSON persistence without a migration", () => {
  const doc = document("unknown", "not_applicable");
  assert.deepEqual(
    storedSupplyNature(serializeFieldsWithLineItems(doc)),
    doc.supplyNature,
  );
});

test("blank, malformed or partial applicability evidence cannot exempt documents", () => {
  const nature = document("not_applicable", "not_applicable").supplyNature!;
  for (const evidence of [
    [],
    [{ sourcePage: 0, quote: "Count-based item" }],
    [{ sourcePage: 1, quote: " " }],
    [null],
  ]) {
    assert.equal(
      readSupplyNature({
        ...nature,
        logisticsRequirements: {
          ...nature.logisticsRequirements,
          weightProof: {
            ...nature.logisticsRequirements!.weightProof,
            evidence,
          },
        },
      }),
      undefined,
    );
  }
  assert.equal(
    readSupplyNature({
      ...nature,
      logisticsRequirements: {
        weightProof: nature.logisticsRequirements!.weightProof,
      },
    }),
    undefined,
  );
  const invalid = document("not_applicable", "not_applicable");
  invalid.supplyNature = { ...nature, logisticsRequirements: {} as never };
  assert.equal(
    packetLogisticsRequirement([invalid], "weightProof"),
    "required",
  );
});

test("unreadable scope can remain unknown without fabricated evidence, but cannot exempt documents", () => {
  const doc = document("unknown", "unknown");
  for (const key of ["transport", "weightProof"] as const) {
    doc.supplyNature!.logisticsRequirements![key].evidence = [];
    doc.supplyNature!.logisticsRequirements![key].reason =
      "The source scope is unreadable.";
  }
  assert.ok(readSupplyNature(doc.supplyNature));
  assert.equal(packetLogisticsRequirement([doc], "weightProof"), "unknown");
  assert.deepEqual(getUnverifiedLogisticsDocumentGroups([doc]), [
    "Transport Document",
    "Weight Proof",
  ]);
});
