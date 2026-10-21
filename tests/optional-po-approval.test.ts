import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

test("optional PO migration removes the legacy upload gate and preserves unrelated triggers", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create table public.packet_cases(id text primary key, status text);
      create table public.packet_documents(case_id text, document_type text, extracted_fields jsonb);
      create function public.require_purchase_order_before_approval() returns trigger language plpgsql as $$ begin return new; end $$;
      create trigger require_purchase_order_before_approval before update of status on public.packet_cases for each row execute function public.require_purchase_order_before_approval();
      create function public.other_approval_guard() returns trigger language plpgsql as $$ begin if new.status='accepted' and new.id='blocked' then raise exception 'Unresolved issue'; end if; return new; end $$;
      create trigger other_approval_guard before update of status on public.packet_cases for each row execute function public.other_approval_guard();
      insert into public.packet_cases values ('goods','completed'),('blocked','completed');
      insert into public.packet_documents values ('goods','Tax Invoice','{"__supplyNature":{"kind":"goods"}}');
    `);
    await db.exec(
      readFileSync(
        "supabase/migrations/20261015130910_service_invoice_po_document_approval.sql",
        "utf8",
      ),
    );
    await assert.rejects(
      db.exec(
        "update public.packet_cases set status='accepted' where id='goods'",
      ),
      /Purchase Order document/,
    );
    const sql = readFileSync(
      "supabase/migrations/20261021081909_optional_po_upload_approval.sql",
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    await db.exec(
      "update public.packet_cases set status='accepted' where id='goods'",
    );
    await assert.rejects(
      db.exec(
        "update public.packet_cases set status='accepted' where id='blocked'",
      ),
      /Unresolved issue/,
    );
    const { rows } = await db.query<{ tgname: string }>(
      "select tgname from pg_trigger where tgrelid='public.packet_cases'::regclass and not tgisinternal",
    );
    assert.deepEqual(
      rows.map((row) => row.tgname),
      ["other_approval_guard"],
    );
  } finally {
    await db.close();
  }
});
