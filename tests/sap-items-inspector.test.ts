import assert from "node:assert/strict";
import test from "node:test";
import {
  itemsReadPath,
  itemsPage,
  parseItemsQuery,
} from "../src/lib/sap-items-inspector";

test("item listing includes all statuses and safely escapes search and cursor", () => {
  const path = itemsReadPath({ search: "O'Brien", after: "IT'001", limit: 50 });
  const params = new URL(path, "https://sap.example").searchParams;
  assert.equal(params.get("$orderby"), "ItemCode asc");
  assert.ok(params.get("$filter")?.includes("ItemCode gt 'IT''001'"));
  assert.ok(params.get("$filter")?.includes("contains(ItemName,'O''Brien')"));
  assert.ok(!params.get("$filter")?.includes("Valid"));
});

test("lookahead supplies a cursor without skipping the extra item", () => {
  const rows = [
    { ItemCode: "A", Valid: "tNO", Frozen: "tYES" },
    { ItemCode: "B" },
    { ItemCode: "C" },
  ];
  const first = itemsPage(rows, 2);
  assert.deepEqual(
    first.records.map((row) => row.code),
    ["A", "B"],
  );
  assert.equal(first.nextCursor, "B");
  assert.equal(first.records[0].valid, false);
  assert.equal(first.records[0].frozen, true);
  assert.equal(itemsPage(rows.slice(2), 2).nextCursor, null);
});

test("invalid page sizes are rejected", () => {
  for (const limit of ["0", "101", "NaN", "1.5"])
    assert.throws(() => parseItemsQuery(new URLSearchParams({ limit })));
});
