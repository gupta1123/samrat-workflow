import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEWayBillValidityIssues,
  indiaCalendarDate,
  parseEWayBillValidityDate,
  EWAY_BILL_VALIDITY_FIELD,
} from "../src/lib/eway-bill-validity";
import { isAlwaysVisibleReviewIssue } from "../src/lib/mismatch-visibility";
import type { CaseDoc } from "../src/types/pipeline";

const today = new Date("2026-10-07T07:00:00Z");
const bill = (date?: string, id = "bill-1"): CaseDoc => ({
  id,
  type: "E-Way Bill",
  title: "E-Way Bill",
  pages: 1,
  fields: { validityDate: date, eWayBillNumber: "123456789012" },
  md: "",
  sourceFileName: "bill.pdf",
  sourcePageNumbers: [3],
});

test("explicit date formats, printed times and real calendar dates", () => {
  for (const date of [
    "2026-10-06",
    "06/10/2026 11:59 PM",
    "6.10.2026",
    "06-10-2026",
    "06-Oct-2026",
    "6 October 2026",
    "2026-10-06T23:59:00+05:30",
  ]) {
    assert.equal(parseEWayBillValidityDate(date), "2026-10-06", date);
  }
  for (const date of [
    "31/02/2026",
    "29/02/2025",
    "10/13/2026",
    "07/10/26",
    "",
    "unreadable",
    "tomorrow",
    "6 Foobar 2026",
  ]) {
    assert.equal(parseEWayBillValidityDate(date), null, date);
  }
  assert.equal(parseEWayBillValidityDate("29/02/2024"), "2024-02-29");
});

test("expired bills are reviewable with own-document evidence", () => {
  const [issue] = buildEWayBillValidityIssues([bill("06/10/2026")], today);
  assert.equal(issue.field, EWAY_BILL_VALIDITY_FIELD);
  assert.equal(issue.values[0].value, "06/10/2026");
  assert.equal(issue.values[0].docId, "bill-1");
  assert.equal(issue.values[0].pageNumber, 3);
  assert.equal(issue.values[0].evidenceField, "validityDate");
  assert.ok(issue.analysis?.includes("expired"));
  assert.ok(issue.analysis?.includes("2026-10-07"));
  assert.equal(isAlwaysVisibleReviewIssue(issue.field), true);
});

test("expires today and future dates do not produce expiry warnings", () => {
  assert.deepEqual(
    buildEWayBillValidityIssues(
      [bill("07/10/2026"), bill("08/10/2026")],
      today,
    ),
    [],
  );
});

test("India midnight, not server UTC or browser timezone, defines today", () => {
  assert.equal(
    indiaCalendarDate(new Date("2026-10-06T18:29:59Z")),
    "2026-10-06",
  );
  assert.equal(
    indiaCalendarDate(new Date("2026-10-06T18:30:00Z")),
    "2026-10-07",
  );
  assert.equal(
    buildEWayBillValidityIssues(
      [bill("06/10/2026")],
      new Date("2026-10-06T18:29:59Z"),
    ).length,
    0,
  );
  assert.equal(
    buildEWayBillValidityIssues(
      [bill("06/10/2026")],
      new Date("2026-10-06T18:30:00Z"),
    ).length,
    1,
  );
});

test("missing or unreadable expiry dates are not guessed as expired", () => {
  for (const date of [undefined, "unreadable", "31/02/2026"]) {
    const [issue] = buildEWayBillValidityIssues([bill(date)], today);
    assert.ok(issue.analysis?.includes("could not be checked"));
    assert.ok(issue.analysis?.includes("not been assumed expired"));
  }
});

test("multiple bills are checked individually; invoice dates are ignored", () => {
  const invoice = { ...bill("01/10/2026"), type: "Tax Invoice" as const };
  const issues = buildEWayBillValidityIssues(
    [
      invoice,
      bill("06/10/2026", "a"),
      bill("08/10/2026", "b"),
      bill("05/10/2026", "c"),
    ],
    today,
  );
  assert.deepEqual(
    issues.map((issue) => issue.values[0].docId),
    ["a", "c"],
  );
});

test("issue identity is stable across days but changes if the document date changes", () => {
  const first = buildEWayBillValidityIssues([bill("06/10/2026")], today)[0];
  const later = buildEWayBillValidityIssues(
    [bill("06/10/2026")],
    new Date("2026-10-08T07:00:00Z"),
  )[0];
  assert.equal(first.id, later.id);
  assert.notEqual(
    first.id,
    buildEWayBillValidityIssues([bill("05/10/2026")], today)[0].id,
  );
});
