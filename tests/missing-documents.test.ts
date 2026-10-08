import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMissingDocumentIssues,
  MISSING_DOCUMENTS_FIELD,
  readMissingDocumentGroups,
} from "../src/lib/missing-documents";
import { getMissingCorePacketDocumentGroups } from "../src/server/case-summary";
import type { CaseDoc } from "../src/types/pipeline";

const document = (id: string, type: CaseDoc["type"]): CaseDoc => ({
  id,
  type,
  title: type,
  pages: 1,
  fields: {},
  md: "",
});

test("only required missing core document groups produce an issue", () => {
  const documents = [document("invoice", "Invoice")];
  const missing = getMissingCorePacketDocumentGroups(documents);
  const issues = buildMissingDocumentIssues(missing);

  assert.deepEqual(missing, ["Transport Document", "Weight Proof"]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, MISSING_DOCUMENTS_FIELD);
  assert.match(
    String(issues[0].values[0].value),
    /Transport Document, Weight Proof/,
  );
});

test("a complete core packet has no missing-document issue", () => {
  const documents = [
    document("po", "Purchase Order"),
    document("invoice", "Tax Invoice"),
    document("eway", "E-Way Bill"),
    document("lr", "Lorry Receipt"),
    document("weight", "Weighment Slip"),
  ];

  const missing = getMissingCorePacketDocumentGroups(documents);
  assert.deepEqual(missing, []);
  assert.deepEqual(buildMissingDocumentIssues(missing), []);
});

test("the UI reads the exact missing groups persisted by processing", () => {
  assert.deepEqual(
    readMissingDocumentGroups({
      missingDocumentGroups: [
        "Purchase Order",
        "Weight Proof",
        "Purchase Order",
      ],
    }),
    ["Weight Proof"],
  );
});

test("absence of PO and e-way bill alone does not create a mismatch", () => {
  const documents = [
    document("invoice", "Tax Invoice"),
    document("lr", "Lorry Receipt"),
    document("weight", "Weighment Slip"),
  ];
  assert.deepEqual(getMissingCorePacketDocumentGroups(documents), []);
  assert.deepEqual(
    buildMissingDocumentIssues(["Purchase Order", "E-Way Bill"]),
    [],
  );
  assert.deepEqual(
    readMissingDocumentGroups({
      missingDocumentGroups: ["Purchase Order", "E-Way Bill"],
    }),
    [],
  );
});

test("other missing documents remain visible when mixed with optional groups", () => {
  const issues = buildMissingDocumentIssues([
    "Purchase Order",
    "Invoice",
    "E-Way Bill",
  ]);
  assert.equal(issues.length, 1);
  assert.equal(
    issues[0].values[0].value,
    "Missing required documents: Invoice",
  );
});
