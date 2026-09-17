import assert from "node:assert/strict";
import { test } from "node:test";

import {
  enforceMismatchEvidenceIntegrity,
  reconcileMismatchesWithReviewedDocuments,
} from "../src/server/process-job";

test("final mismatch integrity removes an impossible identical-value conflict", () => {
  const result = enforceMismatchEvidenceIntegrity([
    {
      id: "review-1",
      field: "eWayBillNumber",
      values: [
        { docId: "invoice", value: "181042763590" },
        { docId: "eway", value: "181042763590" },
      ],
      analysis: "The values do not match.",
    },
  ]);

  assert.deepEqual(result, []);
});

test("final mismatch integrity preserves genuine conflicts and single-page warnings", () => {
  const issues = [
    {
      id: "review-1",
      field: "invoiceNumber",
      values: [
        { docId: "invoice", value: "INV-001" },
        { docId: "eway", value: "INV-002" },
      ],
      analysis: "The visible references differ.",
    },
    {
      id: "quality-1",
      field: "documentReadability",
      values: [{ docId: "invoice", value: "Page 1 is faint" }],
      analysis: "The page cannot be read safely.",
    },
  ];

  assert.deepEqual(enforceMismatchEvidenceIntegrity(issues), issues);
});

test("reviewed corrections remove a candidate mismatch whose evidence no longer exists", () => {
  const issues = [
    {
      id: "gross-weight-candidate",
      field: "grossWeight",
      values: [
        { docId: "invoice", value: "40 MT" },
        { docId: "weighment", value: "55.480 MT" },
      ],
      analysis: "The preliminary values differ.",
    },
  ];
  const documents = [
    {
      id: "invoice",
      type: "Tax Invoice" as const,
      title: "Tax Invoice",
      pages: 1,
      fields: { netWeight: "40 MT" },
      md: "## Visible Text\nTotal net weight 40 MT",
    },
    {
      id: "weighment",
      type: "Weighment Slip" as const,
      title: "Weighment Slip",
      pages: 1,
      fields: { grossWeight: "55.480 MT" },
      md: "## Visible Text\nGross weight 55.480 MT",
    },
  ];

  assert.deepEqual(
    reconcileMismatchesWithReviewedDocuments(issues, documents),
    [],
  );
});

test("reviewed corrections preserve a genuine vehicle conflict with current values", () => {
  const issue = {
    id: "vehicle-candidate",
    field: "vehicleNumber",
    values: [
      { docId: "invoice", value: "TS08UC4721", isOutlier: false },
      { docId: "eway", value: "TS08UC4727", isOutlier: true },
    ],
    analysis: "The printed vehicle numbers differ.",
  };
  const documents = [
    {
      id: "invoice",
      type: "Tax Invoice" as const,
      title: "Tax Invoice",
      pages: 1,
      fields: { vehicleNumber: "TS08UC4721" },
      md: "",
    },
    {
      id: "eway",
      type: "E-Way Bill" as const,
      title: "E-Way Bill",
      pages: 1,
      fields: { vehicleNumber: "TS08UC4727" },
      md: "",
    },
  ];

  assert.deepEqual(
    reconcileMismatchesWithReviewedDocuments([issue], documents),
    [issue],
  );
});
