import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCatalogSuggestions } from "../src/server/sap/catalog-suggestions";
import type { MatchInvoice } from "../src/lib/sap-match/types";

const invoice = (descriptions: string[]) =>
  ({
    lines: descriptions.map((description, index) => ({ index, description })),
  }) as MatchInvoice;

test("catalog suggestions search verbatim and require exact full names, not word overlap", async () => {
  const queries: string[] = [];
  const result = await loadCatalogSuggestions(
    invoice(["Visiting Cards"]),
    async (query) => {
      queries.push(query);
      return [
        {
          ItemCode: "NINV1108",
          ItemName: "Visiting Cards",
          InventoryItem: "tNO",
        },
        { ItemCode: "ID", ItemName: "ID Cards", InventoryItem: "tNO" },
        {
          ItemCode: "PARTIAL",
          ItemName: "Premium Visiting Cards",
          InventoryItem: "tNO",
        },
      ];
    },
  );
  assert.deepEqual(queries, ["Visiting Cards"]);
  assert.deepEqual(
    result.itemMasterSuggestions?.["0"].map((x) => x.itemCode),
    ["NINV1108"],
  );
  assert.match(
    result.itemMasterSuggestions!["0"][0].why,
    /Not proof of a supplier PO match/,
  );
});

test("repeated invoice descriptions reuse one SAP call and retain distinct exact catalog codes", async () => {
  let calls = 0;
  const result = await loadCatalogSuggestions(
    invoice(["Visiting Cards", "Visiting Cards"]),
    async () => {
      calls++;
      return [
        { ItemCode: "A", ItemName: "VISITING CARDS" },
        { ItemCode: "B", ItemName: "Visiting Cards" },
        { ItemCode: "A", ItemName: "Visiting Cards" },
      ];
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    result.itemMasterSuggestions!["0"].map((x) => x.itemCode),
    ["A", "B"],
  );
  assert.deepEqual(
    result.itemMasterSuggestions!["0"],
    result.itemMasterSuggestions!["1"],
  );
});

test("catalog lookup failures are supplementary and reported without failing PO/GRPO matching", async () => {
  const result = await loadCatalogSuggestions(
    invoice(["Cards", "Paper"]),
    async (query) => {
      if (query === "Cards") throw Error("unavailable");
      return [{ ItemCode: "P", ItemName: "Paper" }];
    },
  );
  assert.equal(result.itemMasterSearchUnavailable, true);
  assert.equal(result.itemMasterSuggestions!["1"][0].itemCode, "P");
});

test("missing descriptions trigger no lookup and punctuation is never inferred away", async () => {
  let calls = 0;
  const result = await loadCatalogSuggestions(
    invoice(["", "A", "A-4"]),
    async () => {
      calls++;
      return [{ ItemCode: "X", ItemName: "A4" }];
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result.itemMasterSuggestions, { "2": [] });
});
