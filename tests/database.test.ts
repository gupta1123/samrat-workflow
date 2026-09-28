import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite();
const user = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
type RpcResult = {
  case: { id: string; status: string };
  job: { id: string; status: string };
  duplicateCase: { id: string };
  caseStatus: string;
  status: string;
};
async function scalar<T = RpcResult>(
  sql: string,
  args: unknown[] = [],
): Promise<T> {
  const q = await db.query<{ result: T }>(sql, args);
  return q.rows[0]?.result;
}
before(async () => {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  await db.exec(
    readFileSync(
      new URL(
        "../supabase/migrations/20260831072011_samrat_case_review.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    readFileSync(
      new URL(
        "../supabase/migrations/20260908082256_enforce_case_page_limit.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    readFileSync(
      new URL(
        "../supabase/migrations/20260908084036_improve_analysis_stall_recovery.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    readFileSync(
      new URL(
        "../supabase/migrations/20260908085254_enforce_durable_background_processing.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    readFileSync(
      new URL(
        "../supabase/migrations/20260915073043_guarantee_analysis_start.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    readFileSync(
      new URL(
        "../supabase/migrations/20260909083022_block_approval_for_unreadable_documents.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    readFileSync(
      new URL(
        "../supabase/migrations/20260909101836_verified_page_replacement.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    readFileSync(
      new URL(
        "../supabase/migrations/20260910081027_draft_case_file_editing.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    readFileSync(
      new URL(
        "../supabase/migrations/20260915084504_require_verified_analysis_for_approval.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    readFileSync(
      new URL(
        "../supabase/migrations/20260916071014_require_invoice_number_for_approval.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(
    readFileSync(
      new URL(
        "../supabase/migrations/20260917000000_sap_postings.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.query("insert into auth.users(id) values($1),($2)", [user, other]);
});
after(async () => db.close());
async function upload(
  owner = user,
  hash = randomUUID().replaceAll("-", "").repeat(2),
  name = "invoice.pdf",
  pageCount = 1,
) {
  const id = randomUUID();
  await db.query("select public.reserve_upload($1,$2,$3,$4,$5,$6,$7)", [
    id,
    owner,
    `${owner}/${id}/${name}`,
    name,
    100,
    hash,
    "application/pdf",
  ]);
  await db.query("update public.storage_assets set page_count=$1 where id=$2", [
    pageCount,
    id,
  ]);
  return id;
}
async function createCase(owner = user) {
  const id = await upload(owner);
  const result = await scalar(
    "select public.attach_case_uploads($1,$2) result",
    [owner, [id]],
  );
  return { id: result.case.id as string, upload: id };
}
async function job(caseId: string, owner = user) {
  return scalar("select public.enqueue_case_analysis($1,$2,$3) result", [
    owner,
    caseId,
    { analysisMode: "smart_split" },
  ]);
}
async function claim(id: string, worker = "worker") {
  return scalar("select public.claim_case_job($1,$2) result", [id, worker]);
}
function group(caseId: string, issues = true) {
  return {
    id: caseId,
    displayName: "Sample supplier",
    sourceFileNames: ["invoice.pdf"],
    documents: [
      {
        id: "invoice-1",
        type: "Invoice",
        title: "Invoice",
        pages: 1,
        fields: { invoiceNumber: "INV-001", totalAmount: "100" },
        sourceFileName: "invoice.pdf",
        md: "Sample",
      },
    ],
    mismatches: issues
      ? [
          {
            id: "total-mismatch",
            field: "totalAmount",
            values: [{ docId: "invoice-1", value: "100" }],
            analysis: "Different totals",
            fixPlan: "Confirm original.",
          },
        ]
      : [],
    summary: {
      slug: "sample",
      buyerName: "Samrat Group",
      poNumber: "PO-001",
      invoiceNumber: "INV-001",
      riskScore: 10,
    },
    meta: {
      extractionReview: {
        enabled: true,
        required: true,
        authoritative: true,
      },
      analysisIntegrity: {
        version: 1,
        status: "verified",
        extractionSucceeded: true,
        authoritativeReviewCompleted: true,
        documentCount: 1,
        auditedDocumentCount: 1,
        assessedPageCount: 1,
        unsafePageCount: 0,
        unresolvedDocumentCount: 0,
      },
      lastProcessingError: null,
    },
  };
}
async function complete(
  id: string,
  caseId: string,
  issues = true,
  worker = "worker",
) {
  return db.query("select public.complete_case_job($1,$2,$3,$4)", [
    id,
    worker,
    [group(caseId, issues)],
    {},
  ]);
}

test("migration enables RLS on every application table and restricts internal functions", async () => {
  const rows = await db.query<{ relname: string; relrowsecurity: boolean }>(
    "select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relkind='r'",
  );
  assert.equal(rows.rows.length, 12);
  assert.ok(rows.rows.every((r) => r.relrowsecurity));
  assert.ok(rows.rows.some((row) => row.relname === "packet_file_revisions"));
  assert.ok(rows.rows.some((row) => row.relname === "sap_postings"));
  assert.equal(
    await scalar(
      "select has_function_privilege('authenticated','public.reserve_upload(uuid,uuid,text,text,bigint,text,text)','EXECUTE') result",
    ),
    false,
  );
  assert.equal(
    await scalar(
      "select has_function_privilege('service_role','public.reserve_upload(uuid,uuid,text,text,bigint,text,text)','EXECUTE') result",
    ),
    true,
  );
  assert.equal(
    await scalar(
      "select has_function_privilege('authenticated','public.commit_verified_page_replacement(uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,jsonb,jsonb)','EXECUTE') result",
    ),
    false,
  );
  assert.equal(
    await scalar(
      "select has_function_privilege('authenticated','public.edit_draft_case_file(uuid,uuid,uuid,text,uuid)','EXECUTE') result",
    ),
    false,
  );
  assert.equal(
    await scalar(
      "select has_function_privilege('service_role','public.edit_draft_case_file(uuid,uuid,uuid,text,uuid)','EXECUTE') result",
    ),
    true,
  );
});
test("upload adoption is idempotent and duplicate packets are detected", async () => {
  const hash = "a".repeat(64);
  const asset = await upload(user, hash);
  const first = await scalar(
    "select public.attach_case_uploads($1,$2) result",
    [user, [asset]],
  );
  const again = await scalar(
    "select public.attach_case_uploads($1,$2) result",
    [user, [asset]],
  );
  assert.equal(first.case.id, again.case.id);
  const copied = await upload(user, hash);
  const duplicate = await scalar(
    "select public.attach_case_uploads($1,$2) result",
    [user, [copied]],
  );
  assert.equal(duplicate.duplicateCase.id, first.case.id);
  await assert.rejects(
    () =>
      db.query("select public.attach_case_uploads($1,$2)", [other, [asset]]),
    /Upload not found/,
  );
});
test("case creation and append atomically reject more than 40 pages", async () => {
  const caseCountBefore = await scalar<number>(
    "select count(*)::int result from public.packet_cases where owner_user_id=$1",
    [user],
  );
  const first = await upload(user, undefined, "first.pdf", 25);
  const second = await upload(user, undefined, "second.pdf", 16);
  await assert.rejects(
    () =>
      db.query("select public.attach_case_uploads($1,$2)", [
        user,
        [first, second],
      ]),
    /41 pages.*maximum of 40 pages.*1 page/,
  );
  assert.equal(
    await scalar(
      "select count(*)::int result from public.packet_cases where owner_user_id=$1",
      [user],
    ),
    caseCountBefore,
  );

  const base = await upload(user, undefined, "base.pdf", 30);
  const created = await scalar(
    "select public.attach_case_uploads($1,$2) result",
    [user, [base]],
  );
  const extra = await upload(user, undefined, "extra.pdf", 11);
  await assert.rejects(
    () =>
      db.query("select public.attach_case_uploads($1,$2,$3)", [
        user,
        [extra],
        created.case.id,
      ]),
    /41 pages.*maximum of 40 pages.*1 page/,
  );
  assert.equal(
    await scalar(
      "select count(*)::int result from public.packet_case_files where case_id=$1",
      [created.case.id],
    ),
    1,
  );
});
test("draft documents can be replaced and removed atomically before analysis", async () => {
  const originalHash = "c".repeat(64);
  const replacementHash = "d".repeat(64);
  const originalAsset = await upload(
    user,
    originalHash,
    "original-invoice.pdf",
    2,
  );
  const created = await scalar(
    "select public.attach_case_uploads($1,$2) result",
    [user, [originalAsset]],
  );
  const fileId = await scalar<string>(
    "select id result from public.packet_case_files where case_id=$1",
    [created.case.id],
  );
  const replacementAsset = await upload(
    user,
    replacementHash,
    "corrected-invoice.pdf",
    3,
  );

  const replaced = await scalar<{ case: { upload_count: number } }>(
    "select public.edit_draft_case_file($1,$2,$3,$4,$5) result",
    [user, created.case.id, fileId, "replace", replacementAsset],
  );
  assert.equal(replaced.case.upload_count, 1);
  assert.equal(
    await scalar(
      "select original_name result from public.packet_case_files where id=$1",
      [fileId],
    ),
    "corrected-invoice.pdf",
  );
  assert.equal(
    await scalar(
      "select upload_fingerprint result from public.packet_cases where id=$1",
      [created.case.id],
    ),
    replacementHash,
  );
  assert.equal(
    await scalar(
      "select consumed_case_id result from public.storage_assets where id=$1",
      [originalAsset],
    ),
    null,
  );
  assert.equal(
    await scalar(
      "select consumed_case_id result from public.storage_assets where id=$1",
      [replacementAsset],
    ),
    created.case.id,
  );

  const removed = await scalar<{ case: { upload_count: number } }>(
    "select public.edit_draft_case_file($1,$2,$3,$4,$5) result",
    [user, created.case.id, fileId, "remove", null],
  );
  assert.equal(removed.case.upload_count, 0);
  assert.equal(
    await scalar(
      "select count(*)::int result from public.packet_case_files where case_id=$1",
      [created.case.id],
    ),
    0,
  );
  assert.equal(
    await scalar(
      "select upload_fingerprint result from public.packet_cases where id=$1",
      [created.case.id],
    ),
    null,
  );
  assert.equal(
    await scalar(
      "select consumed_case_id result from public.storage_assets where id=$1",
      [replacementAsset],
    ),
    null,
  );
  assert.equal(
    await scalar(
      "select count(*)::int result from public.case_review_events where case_id=$1 and action in ('draft_file_replaced','draft_file_removed')",
      [created.case.id],
    ),
    2,
  );
});
test("draft document edits are owner-scoped and lock permanently when analysis starts", async () => {
  const c = await createCase();
  const fileId = await scalar<string>(
    "select id result from public.packet_case_files where case_id=$1",
    [c.id],
  );
  await assert.rejects(
    () =>
      db.query("select public.edit_draft_case_file($1,$2,$3,$4,$5)", [
        other,
        c.id,
        fileId,
        "remove",
        null,
      ]),
    /Case not found/,
  );
  await job(c.id);
  await assert.rejects(
    () =>
      db.query("select public.edit_draft_case_file($1,$2,$3,$4,$5)", [
        user,
        c.id,
        fileId,
        "remove",
        null,
      ]),
    /only be changed before analysis starts/,
  );
});
test("a replacement that would exceed the page limit preserves the original", async () => {
  const originalAsset = await upload(user, "e".repeat(64), "base.pdf", 30);
  const extraAsset = await upload(user, "f".repeat(64), "extra.pdf", 5);
  const created = await scalar(
    "select public.attach_case_uploads($1,$2) result",
    [user, [originalAsset, extraAsset]],
  );
  const fileId = await scalar<string>(
    "select id result from public.packet_case_files where case_id=$1 and original_name='extra.pdf'",
    [created.case.id],
  );
  const tooLong = await upload(user, "9".repeat(64), "too-long.pdf", 11);

  await assert.rejects(
    () =>
      db.query("select public.edit_draft_case_file($1,$2,$3,$4,$5)", [
        user,
        created.case.id,
        fileId,
        "replace",
        tooLong,
      ]),
    /41 pages.*maximum of 40 pages/,
  );
  assert.equal(
    await scalar(
      "select original_name result from public.packet_case_files where id=$1",
      [fileId],
    ),
    "extra.pdf",
  );
  assert.equal(
    await scalar(
      "select consumed_case_id result from public.storage_assets where id=$1",
      [tooLong],
    ),
    null,
  );
});
test("one job and one worker can own a case; file writes are blocked during analysis", async () => {
  const c = await createCase();
  const one = await job(c.id);
  const again = await job(c.id);
  assert.equal(one.job.id, again.job.id);
  assert.equal((await claim(one.job.id)).status, "running");
  assert.equal(await claim(one.job.id, "other-worker"), null);
  const another = await upload(user, undefined, "other.pdf");
  await assert.rejects(
    () =>
      db.query("select public.attach_case_uploads($1,$2,$3)", [
        user,
        [another],
        c.id,
      ]),
    /current analysis/,
  );
  await complete(one.job.id, c.id);
});
test("an active background job cannot silently return its case to Draft", async () => {
  const c = await createCase();
  const queued = await job(c.id);
  assert.equal(
    await scalar("select status result from public.packet_cases where id=$1", [
      c.id,
    ]),
    "processing",
  );
  await assert.rejects(
    () =>
      db.query("update public.packet_cases set status='draft' where id=$1", [
        c.id,
      ]),
    /active analysis cannot return to Draft/,
  );
  assert.equal(
    await scalar(
      "select status result from public.packet_processing_jobs where id=$1",
      [queued.job.id],
    ),
    "queued",
  );
  await db.query(
    "update public.packet_processing_jobs set status='cancelled' where id=$1",
    [queued.job.id],
  );
  await db.query("update public.packet_cases set status='draft' where id=$1", [
    c.id,
  ]);
  assert.equal(
    await scalar("select status result from public.packet_cases where id=$1", [
      c.id,
    ]),
    "draft",
  );
});
test("an idempotent Analyze retry repairs a legacy Draft case with an active job", async () => {
  const c = await createCase();
  const queued = await job(c.id);

  await db.exec(
    "alter table public.packet_cases disable trigger prevent_active_analysis_draft",
  );
  await db.query("update public.packet_cases set status='draft' where id=$1", [
    c.id,
  ]);
  await db.exec(
    "alter table public.packet_cases enable trigger prevent_active_analysis_draft",
  );

  const retried = await job(c.id);
  assert.equal(retried.job.id, queued.job.id);
  assert.equal(retried.job.status, "queued");
  assert.equal(retried.case.status, "processing");
  assert.equal(
    await scalar("select status result from public.packet_cases where id=$1", [
      c.id,
    ]),
    "processing",
  );
});
test("stale analysis jobs retry quickly and then fail clearly after the final attempt", async () => {
  const c = await createCase();
  const first = await job(c.id);
  await claim(first.job.id);
  await db.query(
    "update public.packet_processing_jobs set locked_at=now()-interval '3 minutes' where id=$1",
    [first.job.id],
  );
  await db.query("select public.recover_stale_case_jobs()");
  assert.equal(
    await scalar(
      "select status result from public.packet_processing_jobs where id=$1",
      [first.job.id],
    ),
    "queued",
  );
  assert.match(
    await scalar<string>(
      "select error result from public.packet_processing_jobs where id=$1",
      [first.job.id],
    ),
    /stopped reporting activity.*automatic retry/,
  );

  await db.query(
    "update public.packet_processing_jobs set next_run_at=now() where id=$1",
    [first.job.id],
  );
  await claim(first.job.id, "retry-worker");
  await db.query(
    "update public.packet_processing_jobs set locked_at=now()-interval '3 minutes' where id=$1",
    [first.job.id],
  );
  await db.query("select public.recover_stale_case_jobs()");
  assert.equal(
    await scalar(
      "select status result from public.packet_processing_jobs where id=$1",
      [first.job.id],
    ),
    "failed",
  );
  assert.equal(
    await scalar("select status result from public.packet_cases where id=$1", [
      c.id,
    ]),
    "failed",
  );
});
test("mismatch decisions check ownership and gate case acceptance", async () => {
  const c = await createCase();
  const j = await job(c.id);
  await claim(j.job.id);
  await complete(j.job.id, c.id);
  const mismatch = await scalar<string>(
    "select id result from public.packet_mismatches where case_id=$1",
    [c.id],
  );
  await assert.rejects(
    () =>
      db.query("select public.decide_case($1,$2,$3)", [user, c.id, "accept"]),
    /every issue/,
  );
  await assert.rejects(
    () =>
      db.query("select public.resolve_mismatches($1,$2,$3,$4)", [
        other,
        c.id,
        [mismatch],
        "accepted",
      ]),
    /not ready/,
  );
  await db.query("select public.resolve_mismatches($1,$2,$3,$4)", [
    user,
    c.id,
    [mismatch],
    "rejected",
  ]);
  await assert.rejects(
    () =>
      db.query("select public.decide_case($1,$2,$3)", [user, c.id, "accept"]),
    /every issue/,
  );
  const decision = await scalar(
    "select public.resolve_mismatches($1,$2,$3,$4) result",
    [user, c.id, [mismatch], "accepted"],
  );
  assert.equal(decision.caseStatus, "accepted");
});
test("document-reading warnings cannot be settled or approved", async () => {
  const c = await createCase();
  const j = await job(c.id);
  await claim(j.job.id);
  await complete(j.job.id, c.id);
  const mismatch = await scalar<string>(
    "select id result from public.packet_mismatches where case_id=$1",
    [c.id],
  );
  await db.query(
    "update public.packet_mismatches set field_name='documentReadability' where id=$1",
    [mismatch],
  );

  await assert.rejects(
    () =>
      db.query("select public.resolve_mismatches($1,$2,$3,$4)", [
        user,
        c.id,
        [mismatch],
        "accepted",
      ]),
    /cannot be settled/i,
  );
  await assert.rejects(
    () =>
      db.query("select public.decide_case($1,$2,$3)", [user, c.id, "accept"]),
    /approval is blocked/i,
  );
  assert.equal(
    await scalar(
      "select resolution_status result from public.packet_mismatches where id=$1",
      [mismatch],
    ),
    "pending",
  );
  assert.equal(
    await scalar("select status result from public.packet_cases where id=$1", [
      c.id,
    ]),
    "completed",
  );
});
test("approval fails closed without verified reading and extraction evidence", async () => {
  const c = await createCase();
  const j = await job(c.id);
  await claim(j.job.id);
  await complete(j.job.id, c.id, false);

  await db.query(
    "update public.packet_cases set processing_meta=processing_meta-'analysisIntegrity' where id=$1",
    [c.id],
  );
  await assert.rejects(
    () =>
      db.query("select public.decide_case($1,$2,$3)", [user, c.id, "accept"]),
    /document reading and extraction were not fully verified/i,
  );

  await db.query(
    "update public.packet_cases set processing_meta=processing_meta||jsonb_build_object('analysisIntegrity',jsonb_build_object('version',1,'status','blocked','extractionSucceeded',false,'authoritativeReviewCompleted',false,'documentCount',1,'auditedDocumentCount',0,'assessedPageCount',0,'unsafePageCount',0,'unresolvedDocumentCount',1),'lastProcessingError','Document extraction failed') where id=$1",
    [c.id],
  );
  await assert.rejects(
    () =>
      db.query("select public.decide_case($1,$2,$3)", [user, c.id, "accept"]),
    /document reading and extraction were not fully verified/i,
  );
  assert.equal(
    await scalar("select status result from public.packet_cases where id=$1", [
      c.id,
    ]),
    "completed",
  );
});
test("blank invoice numbers block explicit approval, last-issue auto-approval and direct status writes", async () => {
  for (const blank of [
    null,
    "",
    "  ",
    "\t\r\n",
    "\u00a0\ufeff",
    "\u2009\u3000",
  ]) {
    assert.equal(
      await scalar("select public.invoice_reference_has_value($1) result", [
        blank,
      ]),
      false,
    );
  }
  assert.equal(
    await scalar("select public.invoice_reference_has_value('INV-001') result"),
    true,
  );
  const c = await createCase();
  const j = await job(c.id);
  await claim(j.job.id);
  await complete(j.job.id, c.id);
  const mismatch = await scalar<string>(
    "select id result from public.packet_mismatches where case_id=$1",
    [c.id],
  );
  await db.query(
    "update public.packet_documents set extracted_fields=extracted_fields||jsonb_build_object('invoiceNumber','   ') where case_id=$1",
    [c.id],
  );

  await assert.rejects(
    () =>
      db.query("select public.resolve_mismatches($1,$2,$3,$4)", [
        user,
        c.id,
        [mismatch],
        "accepted",
      ]),
    /invoice number is missing/i,
  );
  assert.equal(
    await scalar(
      "select resolution_status result from public.packet_mismatches where id=$1",
      [mismatch],
    ),
    "pending",
  );
  await db.query(
    "update public.packet_mismatches set resolution_status='accepted' where id=$1",
    [mismatch],
  );
  await assert.rejects(
    () =>
      db.query("select public.decide_case($1,$2,$3)", [user, c.id, "accept"]),
    /invoice number is missing/i,
  );
  await assert.rejects(
    () =>
      db.query("update public.packet_cases set status='accepted' where id=$1", [
        c.id,
      ]),
    /invoice number is missing/i,
  );
  await db.query(
    "update public.packet_documents set extracted_fields=extracted_fields||jsonb_build_object('invoiceNumber','INV-001') where case_id=$1",
    [c.id],
  );
  await db.query(
    "update public.packet_cases set invoice_number='  ' where id=$1",
    [c.id],
  );
  await assert.rejects(
    () =>
      db.query("select public.decide_case($1,$2,$3)", [user, c.id, "accept"]),
    /primary invoice number is required/i,
  );
  await db.query(
    "update public.packet_cases set invoice_number='INV-001' where id=$1",
    [c.id],
  );
  await db.query("select public.decide_case($1,$2,$3)", [user, c.id, "accept"]);
  assert.equal(
    await scalar("select status result from public.packet_cases where id=$1", [
      c.id,
    ]),
    "accepted",
  );
});

test("mandatory invoice-number issues cannot be waived even before the last issue", async () => {
  const c = await createCase();
  const j = await job(c.id);
  await claim(j.job.id);
  await complete(j.job.id, c.id);
  const issueId = randomUUID();
  await db.query(
    "insert into public.packet_mismatches(id,case_id,client_mismatch_id,field_name) values($1,$2,'required-invoice-number','invoiceNumberRequired')",
    [issueId, c.id],
  );
  await assert.rejects(
    () =>
      db.query("select public.resolve_mismatches($1,$2,$3,$4)", [
        user,
        c.id,
        [issueId],
        "accepted",
      ]),
    /cannot be settled/i,
  );
  await assert.rejects(
    () =>
      db.query(
        "update public.packet_mismatches set resolution_status='accepted' where id=$1",
        [issueId],
      ),
    /cannot be settled/i,
  );
  assert.equal(
    await scalar(
      "select resolution_status result from public.packet_mismatches where id=$1",
      [issueId],
    ),
    "pending",
  );
});

test("approval requires every primary invoice, not upstream mother-bill context", async () => {
  const c = await createCase();
  const j = await job(c.id);
  await claim(j.job.id);
  await complete(j.job.id, c.id, false);
  await db.query(
    "insert into public.packet_documents(case_id,client_document_id,document_type,title,extracted_fields) values($1,'upstream','Invoice','Upstream invoice','{}')",
    [c.id],
  );
  await assert.rejects(
    () =>
      db.query("select public.decide_case($1,$2,$3)", [user, c.id, "accept"]),
    /invoice number is missing/i,
  );
  await db.query(
    "update public.packet_cases set processing_meta=processing_meta||jsonb_build_object('verificationGroups',$2::jsonb) where id=$1",
    [
      c.id,
      JSON.stringify([
        {
          roleSelection: {
            strategy: "seller_chain",
            primaryDocumentIds: ["invoice-1"],
            contextDocumentIds: ["upstream"],
          },
        },
      ]),
    ],
  );
  await db.query("select public.decide_case($1,$2,$3)", [user, c.id, "accept"]);
  assert.equal(
    await scalar("select status result from public.packet_cases where id=$1", [
      c.id,
    ]),
    "accepted",
  );
  await db.query(
    "update public.packet_cases set status='completed',processing_meta=processing_meta-'verificationGroups' where id=$1",
    [c.id],
  );
  await db.query(
    "delete from public.packet_documents where case_id=$1 and client_document_id='upstream'",
    [c.id],
  );
  await db.query(
    "update public.packet_documents set document_type='E-Way Bill' where case_id=$1",
    [c.id],
  );
  await assert.rejects(
    () =>
      db.query("select public.decide_case($1,$2,$3)", [user, c.id, "accept"]),
    /buyer-facing invoice/i,
  );
});

test("verified page replacement preserves audit assets and queues one reanalysis atomically", async () => {
  const c = await createCase();
  const firstJob = await job(c.id);
  await claim(firstJob.job.id);
  await complete(firstJob.job.id, c.id);
  const mismatch = await scalar<string>(
    "select id result from public.packet_mismatches where case_id=$1",
    [c.id],
  );
  await db.query(
    "update public.packet_mismatches set field_name='documentReadability' where id=$1",
    [mismatch],
  );
  const fileId = await scalar<string>(
    "select id result from public.packet_case_files where case_id=$1",
    [c.id],
  );
  const previousAsset = await scalar<string>(
    "select storage_asset_id result from public.packet_case_files where id=$1",
    [fileId],
  );
  const candidateAsset = await upload(user, undefined, "clear-page.pdf", 1);
  const replacementAsset = await upload(user, undefined, "invoice.pdf", 1);

  const result = await scalar<{
    case: { status: string };
    job: { id: string; status: string };
    revisionId: string;
  }>(
    "select public.commit_verified_page_replacement($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result",
    [
      user,
      c.id,
      fileId,
      previousAsset,
      candidateAsset,
      replacementAsset,
      mismatch,
      1,
      { decision: "accepted", confidence: "high" },
      { analysisMode: "standard", comparisonOptions: {} },
    ],
  );

  assert.equal(result.case.status, "processing");
  assert.equal(result.job.status, "queued");
  assert.equal(
    await scalar(
      "select storage_asset_id result from public.packet_case_files where id=$1",
      [fileId],
    ),
    replacementAsset,
  );
  assert.equal(
    await scalar(
      "select previous_asset_id result from public.packet_file_revisions where id=$1",
      [result.revisionId],
    ),
    previousAsset,
  );
  assert.equal(
    await scalar(
      "select candidate_asset_id result from public.packet_file_revisions where id=$1",
      [result.revisionId],
    ),
    candidateAsset,
  );
  assert.equal(
    await scalar(
      "select count(*)::int result from public.storage_assets where id=$1",
      [previousAsset],
    ),
    1,
  );
  assert.equal(
    await scalar(
      "select count(*)::int result from public.packet_processing_jobs where case_id=$1 and status='queued'",
      [c.id],
    ),
    1,
  );

  await db.query(
    "update public.packet_processing_jobs set status='cancelled' where id=$1",
    [result.job.id],
  );
  await db.query(
    "update public.packet_cases set status='completed' where id=$1",
    [c.id],
  );
});
test("failed finalization rolls back and preserves the previous documents", async () => {
  const c = await createCase();
  const j = await job(c.id);
  await claim(j.job.id);
  await complete(j.job.id, c.id, false);
  const retry = await job(c.id);
  await claim(retry.job.id);
  const broken = group(c.id);
  broken.documents[0].pages = 0;
  await assert.rejects(() =>
    db.query("select public.complete_case_job($1,$2,$3,$4)", [
      retry.job.id,
      "worker",
      [broken],
      {},
    ]),
  );
  assert.equal(
    await scalar(
      "select count(*)::int result from public.packet_documents where case_id=$1",
      [c.id],
    ),
    1,
  );
  await assert.rejects(
    () => complete(retry.job.id, c.id, true, "stale-worker"),
    /superseded/,
  );
  await db.query("select public.fail_case_job($1,$2,$3,$4)", [
    retry.job.id,
    "worker",
    "Unsupported file",
    false,
  ]);
  assert.equal(
    await scalar("select status result from public.packet_cases where id=$1", [
      c.id,
    ]),
    "failed",
  );
  assert.equal(
    await scalar(
      "select count(*)::int result from public.packet_documents where case_id=$1",
      [c.id],
    ),
    1,
  );
});
test("recycling cancels processing, restoration is safe, hard deletion requires recycling", async () => {
  const c = await createCase();
  const j = await job(c.id);
  await claim(j.job.id);
  await assert.rejects(
    () =>
      db.query("select public.decide_case($1,$2,$3)", [user, c.id, "delete"]),
    /recycle bin/,
  );
  await db.query("select public.decide_case($1,$2,$3)", [
    user,
    c.id,
    "recycle",
  ]);
  assert.equal(
    await scalar(
      "select status result from public.packet_processing_jobs where id=$1",
      [j.job.id],
    ),
    "cancelled",
  );
  await assert.rejects(() => complete(j.job.id, c.id), /no longer exists/);
  await db.query("select public.decide_case($1,$2,$3)", [
    user,
    c.id,
    "restore",
  ]);
  assert.equal(
    await scalar("select status result from public.packet_cases where id=$1", [
      c.id,
    ]),
    "draft",
  );
  await db.query("select public.decide_case($1,$2,$3)", [
    user,
    c.id,
    "recycle",
  ]);
  await db.query("select public.decide_case($1,$2,$3)", [user, c.id, "delete"]);
  assert.equal(
    await scalar(
      "select count(*)::int result from public.packet_cases where id=$1",
      [c.id],
    ),
    0,
  );
});
test("RLS prevents reading another user’s case, and browser roles cannot write", async () => {
  const own = await createCase(user);
  const foreign = await createCase(other);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  await db.exec("set role authenticated");
  try {
    assert.equal(
      await scalar(
        "select count(*)::int result from public.packet_cases where id=$1",
        [own.id],
      ),
      1,
    );
    assert.equal(
      await scalar(
        "select count(*)::int result from public.packet_cases where id=$1",
        [foreign.id],
      ),
      0,
    );
    await assert.rejects(
      () =>
        db.query("update public.packet_cases set status=$1 where id=$2", [
          "accepted",
          own.id,
        ]),
      /permission denied/,
    );
    await assert.rejects(
      () =>
        db.query("select public.decide_case($1,$2,$3)", [
          user,
          own.id,
          "recycle",
        ]),
      /permission denied/,
    );
  } finally {
    await db.exec("reset role");
  }
});
test("review settings are saved atomically and bank statements stay disabled", async () => {
  await db.query("select public.save_review_settings($1,$2,$3)", [
    [{ doc_type: "Invoice", field_key: "invoiceNumber", enabled: false }],
    [{ doc_type: "Invoice", enabled: true }],
    [],
  ]);
  assert.equal(
    await scalar(
      "select enabled result from public.field_settings where field_key='invoiceNumber'",
    ),
    false,
  );
  assert.equal(
    await scalar(
      "select enabled result from public.doc_type_settings where doc_type='Bank Statement'",
    ),
    false,
  );
});
test("sap_postings table tracks one GRN/AP record per case and environment", async () => {
  const columns = (
    await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema='public' and table_name='sap_postings' order by 1",
    )
  ).rows.map((row) => row.column_name);
  assert.deepEqual(columns, [
    "case_id",
    "created_at",
    "error",
    "id",
    "kind",
    "owner_user_id",
    "payload",
    "response",
    "sap_docnum",
    "sap_env",
    "status",
    "updated_at",
  ]);
  // Invalid kind/status are rejected by check constraints.
  await assert.rejects(
    db.query(
      "insert into public.sap_postings(case_id, owner_user_id, kind, status) values($1,$2,$3,$4)",
      [randomUUID(), user, "INVOICE", "prepared"],
    ),
  );
});
