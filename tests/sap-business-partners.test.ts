import assert from "node:assert/strict";
import { test } from "node:test";
import {
  businessPartnerPage,
  businessPartnerReadPath,
  normalizeBusinessPartner,
  parseBusinessPartnerQuery,
} from "../src/lib/sap-business-partners";
import { readODataCollection } from "../src/server/sap/odata-pagination";

test("Business Partners default read includes every type and validity state", () => {
  const query = parseBusinessPartnerQuery(new URLSearchParams());
  const path = new URL(
    businessPartnerReadPath(query),
    "https://sap.example.test",
  );
  assert.equal(path.pathname, "/BusinessPartners");
  assert.equal(path.searchParams.has("$filter"), false);
  assert.equal(path.searchParams.get("$orderby"), "CardCode asc");
  assert.match(path.searchParams.get("$select")!, /BPAddresses/);
});

test("Business Partner search and cursor escape literals and validate type and limits", () => {
  const query = parseBusinessPartnerQuery(
    new URLSearchParams({
      q: "O'Brien",
      after: "V'001",
      type: "cSupplier",
      limit: "25",
    }),
  );
  const filter = new URL(
    businessPartnerReadPath(query),
    "https://sap.example.test",
  ).searchParams.get("$filter")!;
  assert.match(filter, /CardType eq 'cSupplier'/);
  assert.match(filter, /CardCode gt 'V''001'/);
  assert.match(filter, /contains\(CardName,'O''Brien'\)/);
  for (const input of [
    { type: "bad" },
    { limit: "1000" },
    { limit: "NaN" },
    { limit: "0" },
  ] as Array<Record<string, string>>)
    assert.throws(() => parseBusinessPartnerQuery(new URLSearchParams(input)));
});

test("Business Partner GSTINs come from addresses, retain multiple GSTINs, and unknown flags stay unknown", () => {
  const record = normalizeBusinessPartner({
    CardCode: "TSPL001",
    CardName: "Tata Steel",
    CardType: "cSupplier",
    Valid: "tYES",
    Frozen: "tNO",
    BPAddresses: [
      { GSTIN: "GST-1", AddressName: "Head office" },
      { GSTIN: "GST-1" },
      { GSTIN: "GST-2" },
      { GSTIN: "" },
    ],
  });
  assert.deepEqual(record.gstins, ["GST-1", "GST-2"]);
  assert.equal(record.addresses.length, 4);
  assert.equal(record.valid, true);
  assert.equal(record.frozen, false);
  const unknown = normalizeBusinessPartner({ CardCode: "C001" });
  assert.equal(unknown.valid, null);
  assert.equal(unknown.frozen, null);
  assert.throws(() => normalizeBusinessPartner({ CardName: "Missing code" }));
});

test("Business Partners page through more than 100 records despite SAP's 20-row response cap", async () => {
  const source = Array.from({ length: 125 }, (_, i) => ({
    CardCode: `BP${String(i + 1).padStart(4, "0")}`,
    CardName: `Partner ${i + 1}`,
    CardType: i % 2 ? "cSupplier" : "cCustomer",
  }));
  const collected: string[] = [];
  let after: string | null = null;
  do {
    const query = { search: "", type: "all" as const, after, limit: 50 };
    const eligible = source.filter((row) => !after || row.CardCode > after);
    const rows = await readODataCollection<Record<string, unknown>>({
      initialPath: businessPartnerReadPath(query),
      baseUrl: "https://sap.example.test/b1s/v1",
      max: 51,
      read: async (path) => {
        const skip = Number(
          new URL(path, "https://sap.example.test").searchParams.get("$skip") ??
            0,
        );
        return { value: eligible.slice(skip, skip + 20) };
      },
    });
    const page = businessPartnerPage(rows, 50);
    collected.push(...page.records.map((row) => row.code));
    after = page.nextCursor;
  } while (after);
  assert.deepEqual(
    collected,
    source.map((row) => row.CardCode),
  );
  assert.equal(new Set(collected).size, 125);
});

test("exactly full final Business Partners page disables Next", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ CardCode: `V${i}` }));
  assert.equal(businessPartnerPage(rows, 50).nextCursor, null);
  assert.deepEqual(businessPartnerPage([], 50), {
    records: [],
    nextCursor: null,
  });
});
