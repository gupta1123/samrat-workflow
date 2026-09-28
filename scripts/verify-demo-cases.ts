import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { verifyGroupedCaseDocuments } from "../src/server/services/verification";
import type { CaseDoc } from "../src/types/pipeline";

const root = resolve("output/pdf/samrat-demo-cases/validation");
const cases = JSON.parse(
  readFileSync(resolve(root, "reference-data.json"), "utf8"),
) as Array<{
  caseNumber: number;
  packet: string;
  documents: CaseDoc[];
  expectedFields: string[];
}>;

const results = cases.map((fixture) => {
  const result = verifyGroupedCaseDocuments(fixture.documents, {
    considerFormatting: false,
  });
  const fields = [...new Set(result.mismatches.map((m) => m.field))].sort();
  assert.equal(
    result.groups.length,
    1,
    `Case ${fixture.caseNumber} should stay in one group`,
  );
  assert.equal(
    result.groups[0].documentIds.length,
    6,
    "All six documents must be grouped",
  );
  assert.deepEqual(
    fields,
    [...fixture.expectedFields].sort(),
    `Case ${fixture.caseNumber} findings`,
  );
  const separateFiles = fixture.documents.map((doc) => ({
    ...doc,
    sourceFileName: doc.sourceHint,
  }));
  const separateResult = verifyGroupedCaseDocuments(separateFiles, {
    considerFormatting: false,
  });
  assert.equal(
    separateResult.groups.length,
    1,
    "Separate PDFs must also stay in one group",
  );
  assert.deepEqual(
    [...new Set(separateResult.mismatches.map((m) => m.field))].sort(),
    fields,
  );
  console.log(
    `Case ${fixture.caseNumber}: six documents, one group; ${result.mismatches.length} reference-field findings: ${fields.join(", ") || "none"}`,
  );
  return {
    caseNumber: fixture.caseNumber,
    packet: fixture.packet,
    groupedDocuments: result.groups[0].documentIds.length,
    combinedAndSeparateFilesAgree: true,
    fields,
    mismatches: result.mismatches.map(({ field, values }) => ({
      field,
      values,
    })),
    scope:
      "Local comparison of supplied reference fields only. AI extraction and terms review were not called.",
  };
});
writeFileSync(
  resolve(root, "comparison-results.json"),
  JSON.stringify(results, null, 2) + "\n",
);
