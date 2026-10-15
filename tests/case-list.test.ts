import assert from "node:assert/strict";
import { test } from "node:test";
import { createCaseListLoader, type CaseListQuery } from "../src/lib/case-list";
import type {
  fetchCasePage,
  SavedCaseRecord,
} from "../src/lib/case-persistence";

const query: CaseListQuery = {
  query: "",
  approval: "all",
  reconciliation: "all",
  page: 1,
  pageSize: 10,
};
const records = (count: number): SavedCaseRecord[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `case-${index + 1}`,
    slug: `case-${index + 1}`,
    displayName: `Supplier ${index + 1}`,
    buyerName: null,
    receiverName: null,
    category: "Invoice",
    invoiceNumber: null,
    poNumber: null,
    status: "completed",
    riskScore: 0,
    uploadCount: 1,
    documentCount: 1,
    mismatchCount: index % 2,
    createdAt: "2026-10-15",
    deletedAt: null,
  }));
function source(count: number) {
  let rows = records(count);
  const requests: Parameters<typeof fetchCasePage>[0][] = [];
  const readPage: typeof fetchCasePage = async (params) => {
    requests.push(params);
    const start = ((params.page ?? 1) - 1) * (params.limit ?? 25);
    return {
      cases: rows.slice(start, start + (params.limit ?? 25)),
      totalCount: rows.length,
      totalPages: Math.max(1, Math.ceil(rows.length / (params.limit ?? 25))),
    };
  };
  return {
    loader: createCaseListLoader(readPage),
    requests,
    remove: (id: string) => {
      rows = rows.filter((row) => row.id !== id);
    },
  };
}

test("deletion refills the current page from the next page at every supported size", async () => {
  for (const pageSize of [10, 25, 50]) {
    const data = source(pageSize * 3);
    const params = { ...query, page: 2, pageSize };
    const before = await data.loader.read(params);
    const removed = before.cases[3].id;
    data.remove(removed);
    const after = await data.loader.refillAfterRemoval(params);
    assert.equal(after.page, 2);
    assert.equal(after.cases.length, pageSize);
    assert.equal(after.cases.at(-1)?.id, `case-${pageSize * 2 + 1}`);
    assert.ok(!after.cases.some((row) => row.id === removed));
    assert.equal(after.totalCount, pageSize * 3 - 1);
  }
});

test("successive deletions keep ten rows until fewer than ten cases remain", async () => {
  const data = source(13);
  for (let removed = 1; removed <= 5; removed++) {
    data.remove(`case-${removed}`);
    const result = await data.loader.refillAfterRemoval(query);
    assert.equal(result.cases.length, Math.min(10, 13 - removed));
    assert.equal(result.cases[0].id, `case-${removed + 1}`);
    assert.equal(result.totalCount, 13 - removed);
  }
});

test("deleting the only row on the last page returns the previous full page", async () => {
  const data = source(21);
  await data.loader.read({ ...query, page: 3 });
  data.remove("case-21");
  const result = await data.loader.refillAfterRemoval({ ...query, page: 3 });
  assert.equal(result.page, 2);
  assert.equal(result.totalPages, 2);
  assert.equal(result.cases.length, 10);
  assert.equal(result.cases[0].id, "case-11");
  assert.deepEqual(data.loader.peek({ ...query, page: 2 }), {
    cases: result.cases,
    totalCount: 20,
    totalPages: 2,
  });
});

test("deleting the last remaining case leaves an empty first page", async () => {
  const data = source(1);
  data.remove("case-1");
  assert.deepEqual(await data.loader.refillAfterRemoval(query), {
    cases: [],
    totalCount: 0,
    totalPages: 1,
    page: 1,
  });
});

test("a partially filled last page stays selected while it still has cases", async () => {
  const data = source(13);
  data.remove("case-12");
  const result = await data.loader.refillAfterRemoval({ ...query, page: 2 });
  assert.equal(result.page, 2);
  assert.equal(result.totalPages, 2);
  assert.deepEqual(
    result.cases.map((row) => row.id),
    ["case-11", "case-13"],
  );
});

test("a failed refill can be retried without resurrecting a stale cached page", async () => {
  let fail = false;
  const loader = createCaseListLoader(async () => {
    if (fail) throw new Error("Network unavailable");
    return { cases: records(10), totalCount: 10, totalPages: 1 };
  });
  await loader.read(query);
  fail = true;
  await assert.rejects(loader.refillAfterRemoval(query));
  assert.equal(loader.peek(query), undefined);
  fail = false;
  assert.equal((await loader.read(query)).cases.length, 10);
});

test("refilling preserves search and approval filters and never reuses another page's cache", async () => {
  const data = source(23);
  const filtered = {
    ...query,
    query: "Supplier",
    approval: "in_review" as const,
  };
  await data.loader.read({ ...filtered, page: 2 });
  data.remove("case-1");
  const result = await data.loader.refillAfterRemoval(filtered);
  assert.equal(result.cases.length, 10);
  assert.equal(result.cases[0].id, "case-2");
  assert.equal(data.loader.peek({ ...filtered, page: 2 }), undefined);
  assert.equal(data.requests.at(-1)?.query, "Supplier");
  assert.equal(data.requests.at(-1)?.statusFilter, "in_review");
  assert.equal(data.requests.at(-1)?.limit, 10);
});

test("client-side reconciliation pages refill with matching cases only", async () => {
  for (const reconciliation of ["issues", "clean"] as const) {
    const data = source(26);
    const filtered = { ...query, reconciliation };
    const before = await data.loader.read(filtered);
    data.remove(before.cases[0].id);
    const after = await data.loader.refillAfterRemoval(filtered);
    assert.equal(after.cases.length, 10);
    assert.equal(after.totalCount, 12);
    assert.ok(
      after.cases.every((row) =>
        reconciliation === "issues"
          ? row.mismatchCount > 0
          : row.mismatchCount === 0,
      ),
    );
    assert.equal(
      after.cases.at(-1)?.id,
      reconciliation === "issues" ? "case-22" : "case-21",
    );
  }
});

test("a pre-delete response cannot overwrite the refreshed page or its pending request", async () => {
  type Response = Awaited<ReturnType<typeof fetchCasePage>>;
  const pending: Array<(value: Response) => void> = [];
  let calls = 0;
  const loader = createCaseListLoader(async () => {
    calls++;
    return new Promise<Response>((resolve) => pending.push(resolve));
  });
  const old = loader.read(query);
  const oldRevision = loader.revision;
  const refill = loader.refillAfterRemoval(query);
  assert.notEqual(loader.revision, oldRevision);
  pending[0]({ cases: records(10), totalCount: 21, totalPages: 3 });
  await old;
  assert.equal(loader.peek(query), undefined);
  const sameNewRequest = loader.read(query);
  assert.equal(calls, 2);
  const fresh = records(11).slice(1);
  pending[1]({ cases: fresh, totalCount: 20, totalPages: 2 });
  await Promise.all([refill, sameNewRequest]);
  assert.equal(loader.peek(query)?.cases[0].id, "case-2");
});
