import { test } from "node:test";
import assert from "node:assert/strict";
import { queueIntakeAnalysis } from "../src/server/automatic-intake";
import { runInvoiceInboxCycle } from "../src/server/ftp-inbox/worker";
import { automaticGrpoCandidate } from "../src/server/sap/automatic-grpo";

const receipt = {
  DocEntry: 176126,
  DocNum: 103532,
  CardCode: "TEST001",
  NumAtCard: "INV-01",
  DocDate: "2026-11-16T00:00:00Z",
  AttachmentEntry: 1,
  DocumentLines: [{ LineStatus: "bost_Open", RemainingOpenQuantity: 2 }],
};
const attachment = {
  Attachments2_Lines: [
    { FileName: "invoice", FileExtension: "pdf", AttachmentDate: "2026-11-10" },
  ],
};
const candidate = (row: Record<string, unknown>, files = attachment) =>
  automaticGrpoCandidate(row, files, "2026-11-09", "2026-11-16");

test("automatic GRPO intake catches new attachments on older receipts", () => {
  assert.equal(candidate(receipt)?.number, 103532);
  assert.equal(
    candidate({ ...receipt, DocDate: "2026-11-01" })?.number,
    103532,
  );
  const old = {
    Attachments2_Lines: [
      { ...attachment.Attachments2_Lines[0], AttachmentDate: "2026-11-08" },
    ],
  };
  assert.equal(candidate({ ...receipt, DocDate: "2026-11-08" }, old), null);
});

test("automatic GRPO intake requires a PDF, a reference and quantity left to bill", () => {
  assert.equal(candidate(receipt, { Attachments2_Lines: [] }), null);
  assert.equal(candidate({ ...receipt, NumAtCard: "000" }), null);
  assert.equal(
    candidate({
      ...receipt,
      DocumentLines: [{ LineStatus: "bost_Open", RemainingOpenQuantity: 0 }],
    }),
    null,
  );
});

test("automatic intake leaves the case untouched if work arrives before enqueue", async () => {
  let calls = 0;
  const db = {
    from: (table: string) => ({
      select: () => ({
        in: () => ({
          limit: () =>
            Promise.resolve({
              data:
                table === "sap_match_jobs"
                  ? [{ case_id: "already-queued" }]
                  : [],
              error: null,
            }),
        }),
      }),
    }),
    rpc: () => {
      calls++;
      throw new Error("Automatic intake should wait");
    },
  } as unknown as Parameters<typeof queueIntakeAnalysis>[0];
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  try {
    assert.equal(
      await queueIntakeAnalysis(db, "reviewer", "new-case", true),
      null,
    );
    assert.equal(calls, 0);
  } finally {
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  }
});

test("the FTP cycle queues an eligible saved invoice once without a button click", async (t) => {
  const now = new Date("2026-11-16T12:00:00Z");
  const row = {
    id: "ftp-entry",
    status: "ready",
    owner_user_id: "reviewer",
    case_id: "saved-case",
  };
  let queued = false;
  const enqueues: unknown[] = [];
  const db = {
    from(table: string) {
      let changes: Record<string, unknown> | undefined;
      let status: string | undefined;
      let fetchingByCase = false;
      const resolve = () => {
        if (table === "ftp_invoice_sync")
          return { last_checked_at: now.toISOString(), error: null };
        if (table === "sap_match_jobs") return [];
        if (table === "packet_processing_jobs")
          return fetchingByCase ? null : queued ? [{ id: "analysis" }] : [];
        if (changes && (!status || status === row.status))
          return Object.assign(row, changes);
        return status === "ready" && row.status === "ready" ? row : null;
      };
      const query = {
        select: () => query,
        update(values: Record<string, unknown>) {
          changes = values;
          return query;
        },
        eq(column: string, value: string) {
          if (column === "status") status = value;
          if (column === "case_id") fetchingByCase = true;
          return query;
        },
        in: () => query,
        lt: () => query,
        lte: () => query,
        gte: () => query,
        gt: () => query,
        or: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: () => Promise.resolve({ data: resolve(), error: null }),
        then: (done: (result: unknown) => unknown) =>
          Promise.resolve(done({ data: resolve(), error: null })),
      };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      assert.equal(name, "enqueue_case_analysis");
      enqueues.push(args);
      queued = true;
      return {
        data: {
          case: { status: "processing" },
          job: { id: "analysis", status: "queued" },
        },
        error: null,
      };
    },
  } as unknown as Parameters<typeof runInvoiceInboxCycle>[0];
  const ftp = {
    list: async () => {
      throw new Error("Already scanned");
    },
    download: async () => {
      throw new Error("Saved PDFs must not be downloaded again");
    },
    archive: async () => {
      throw new Error("Analysis has not completed");
    },
  } as Parameters<typeof runInvoiceInboxCycle>[1];
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  });
  const config = {
    owner: "reviewer",
    fromDate: "2026-11-09",
    fromInstant: "2026-11-08T18:30:00Z",
  };
  await runInvoiceInboxCycle(db, ftp, now, config);
  await runInvoiceInboxCycle(db, ftp, now, config);
  assert.equal(row.status, "analyzing");
  assert.equal(enqueues.length, 1);
  assert.equal(
    (enqueues[0] as { p_options: { automaticIntake: boolean } }).p_options
      .automaticIntake,
    true,
  );
});
