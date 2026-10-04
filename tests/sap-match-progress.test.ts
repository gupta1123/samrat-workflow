import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type {
  SapMatchResponse,
  SapMatchPosting,
} from "../src/lib/sap-match-client";
import {
  findPostedApInvoice,
  needsSapMatchPolling,
  pollSapMatch,
} from "../src/lib/sap-match-progress";

function unexpectedError(error: unknown): never {
  throw error;
}

const posted: SapMatchPosting = {
  kind: "AP",
  status: "posted",
  sap_env: "test",
  sap_docnum: "848",
  error: null,
  created_at: "2026-10-01",
  updated_at: "2026-10-01",
};

function response(
  status: NonNullable<SapMatchResponse["matchJob"]>["status"],
): SapMatchResponse {
  return {
    available: false,
    sapEnv: "test",
    caseStatus: "accepted",
    postable: true,
    postings: [],
    matchJob: {
      status,
      stage: "Reading SAP documents",
      error: null,
      attempt: 1,
      requestedAt: "2026-10-04",
      finishedAt: null,
    },
  };
}

test("only a numbered, posted AP in the active SAP company completes matching", () => {
  for (const invalid of [
    { ...posted, kind: "GRN" },
    { ...posted, status: "prepared" },
    { ...posted, sap_env: "live" },
    { ...posted, sap_docnum: null },
    { ...posted, sap_docnum: "  " },
  ]) {
    assert.equal(findPostedApInvoice([invalid], "test"), null);
  }
  assert.equal(
    findPostedApInvoice([{ ...posted, kind: "GRN" }, posted], "test"),
    posted,
  );
  assert.equal(
    findPostedApInvoice([{ ...posted, sap_env: "live" }], "live")?.sap_docnum,
    "848",
  );
  assert.equal(
    needsSapMatchPolling({ ...response("running"), postings: [posted] }),
    false,
  );
  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    assert.equal(needsSapMatchPolling(response(status)), false);
  }
  assert.equal(needsSapMatchPolling(null), false);
});

for (const pending of ["queued", "running"] as const) {
  test(`keeps polling identical ${pending} responses until the job finishes`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    const stop = pollSapMatch(
      async () => response(++calls < 5 ? pending : "succeeded"),
      unexpectedError,
    );
    t.after(stop);
    for (let count = 1; count <= 5; count++) {
      t.mock.timers.tick(2_000);
      await setImmediate();
      assert.equal(calls, count);
    }
    t.mock.timers.tick(20_000);
    await setImmediate();
    assert.equal(calls, 5);
  });
}

test("slow polls never overlap, and cleanup prevents an in-flight poll from restarting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolve!: (value: SapMatchResponse) => void;
  let calls = 0;
  const stop = pollSapMatch(() => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  }, unexpectedError);
  t.after(stop);
  t.mock.timers.tick(2_000);
  t.mock.timers.tick(20_000);
  assert.equal(calls, 1);
  stop();
  resolve(response("running"));
  await setImmediate();
  t.mock.timers.tick(20_000);
  assert.equal(calls, 1);
});

test("cleanup cancels a scheduled poll", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const stop = pollSapMatch(async () => {
    calls++;
    return response("running");
  }, unexpectedError);
  stop();
  t.mock.timers.tick(20_000);
  await setImmediate();
  assert.equal(calls, 0);
});

test("a failed request reports its error once and stops polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const failure = new Error("Session expired");
  const errors: unknown[] = [];
  let calls = 0;
  const stop = pollSapMatch(
    async () => {
      calls++;
      throw failure;
    },
    (error) => errors.push(error),
  );
  t.after(stop);
  t.mock.timers.tick(2_000);
  await setImmediate();
  t.mock.timers.tick(20_000);
  await setImmediate();
  assert.equal(calls, 1);
  assert.deepEqual(errors, [failure]);
});

for (const terminal of [
  "succeeded",
  "failed",
  "cancelled",
  "posted",
  "unavailable",
] as const) {
  test(`stops immediately on a ${terminal} response`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const result =
      terminal === "posted"
        ? { ...response("running"), postings: [posted] }
        : terminal === "unavailable"
          ? null
          : response(terminal);
    let calls = 0;
    const stop = pollSapMatch(async () => {
      calls++;
      return result;
    }, unexpectedError);
    t.after(stop);
    t.mock.timers.tick(2_000);
    await setImmediate();
    t.mock.timers.tick(20_000);
    await setImmediate();
    assert.equal(calls, 1);
  });
}
