import assert from "node:assert/strict";
import test from "node:test";
import { recomputeFromSnapshot } from "@/server/sap/match-job";

type Row = Record<string, unknown>;

/** Just enough of the Supabase query builder for the job row and the match state. */
function fakeDb(job: Row | null, state: Row | null = null) {
  const calls: { updated: Row | null } = { updated: null };
  const db = {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({
          data: table === "sap_match_jobs" ? job : state,
          error: null,
        }),
        update(values: Row) {
          calls.updated = values;
          return {
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  select: async () => ({
                    data: [{ case_id: "c" }],
                    error: null,
                  }),
                }),
              }),
            }),
          };
        },
      };
      return builder;
    },
  };
  return { db: db as never, calls };
}

const NOW = Date.parse("2026-10-16T12:00:00Z");
const invoice = {
  lines: [],
  invoiceNumber: "1",
  poReferences: [],
} as never;
const job = (overrides: Row = {}, context: Row | null = {}) => ({
  case_id: "c",
  version: 3,
  status: "succeeded",
  result: {
    available: true,
    invoice,
    rules: { branches: [], receiptWindowDays: 30, postingDate: "today" },
    state: { decisions: {}, allocations: {} },
    vendor: null,
    branch: null,
    result: {},
    ...(context
      ? { context: { checkedAt: "2026-10-16T11:55:00Z", ...context } }
      : {}),
    ...overrides,
  },
});

test("a choice is not re-evaluated when there is no saved SAP read", async () => {
  const { db, calls } = fakeDb(job({}, null));
  assert.equal(await recomputeFromSnapshot(db, "u", "c", NOW), false);
  assert.equal(calls.updated, null);
});

test("an old SAP read is refreshed from SAP instead of reused", async () => {
  const { db, calls } = fakeDb(job({}, { checkedAt: "2026-10-16T11:00:00Z" }));
  assert.equal(await recomputeFromSnapshot(db, "u", "c", NOW), false);
  assert.equal(calls.updated, null);
});

test("a job that is not finished is never recomputed", async () => {
  const { db } = fakeDb({ ...job(), status: "running" });
  assert.equal(await recomputeFromSnapshot(db, "u", "c", NOW), false);
});
