import assert from "node:assert/strict";
import { test } from "node:test";

import { readODataCollection } from "../src/server/sap/odata-pagination";

test("SAP collection paging continues after a server-capped short page", async () => {
  const source = Array.from({ length: 45 }, (_, index) => ({ id: index + 1 }));
  const requested: string[] = [];
  const rows = await readODataCollection({
    initialPath: "/BusinessPartners?$orderby=CardCode%20asc",
    baseUrl: "https://sap.example.test/b1s/v1",
    max: 100,
    read: async (path) => {
      requested.push(path);
      const url = new URL(path, "https://sap.example.test/b1s/v1/");
      const skip = Number(url.searchParams.get("$skip") ?? 0);
      return { value: source.slice(skip, skip + 20) };
    },
  });

  assert.equal(rows.length, 45);
  assert.deepEqual(rows.at(-1), { id: 45 });
  assert.ok(requested.some((path) => path.includes("%24skip=20")));
  assert.ok(requested.some((path) => path.includes("%24skip=40")));
});

test("SAP collection paging follows the OData continuation link", async () => {
  const requested: string[] = [];
  const rows = await readODataCollection({
    initialPath: "/BusinessPartners",
    baseUrl: "https://sap.example.test/b1s/v1",
    max: 10,
    read: async (path) => {
      requested.push(path);
      if (requested.length === 1) {
        return {
          value: [{ id: 1 }, { id: 2 }],
          "odata.nextLink": "BusinessPartners?$skip=2&$top=2",
        };
      }
      return requested.length === 2 ? { value: [{ id: 3 }] } : { value: [] };
    },
  });

  assert.deepEqual(rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(
    new URL(requested[1], "https://sap.example.test/b1s/v1/").searchParams.get("$skip"),
    "2",
  );
});

test("SAP collection paging rejects external continuation links", async () => {
  await assert.rejects(
    readODataCollection({
      initialPath: "/BusinessPartners",
      baseUrl: "https://sap.example.test/b1s/v1",
      max: 10,
      read: async () => ({
        value: [{ id: 1 }],
        "@odata.nextLink": "https://other.example.test/BusinessPartners?$skip=1",
      }),
    }),
    /outside its Service Layer endpoint/,
  );
});
