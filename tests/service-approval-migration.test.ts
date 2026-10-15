import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { isServiceOnlyPacket } from "../src/lib/supply-nature";

test("service approval migration exempts only source-evidenced service invoices and preserves other approval triggers", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
   create table public.packet_cases(id text primary key,status text);
   create table public.packet_documents(case_id text,document_type text,extracted_fields jsonb);
   create function public.require_purchase_order_before_approval() returns trigger language plpgsql as $$ begin raise exception 'old rule'; end $$;
   create trigger require_purchase_order_before_approval before update of status on public.packet_cases for each row execute function public.require_purchase_order_before_approval();
   create function public.test_other_approval_guard() returns trigger language plpgsql as $$ begin if new.status='accepted' and new.id='other-guard' then raise exception 'Other approval check still enforced'; end if; return new; end $$;
   create trigger other_guard before update of status on public.packet_cases for each row execute function public.test_other_approval_guard();
  `);
    const sql = readFileSync(
      "supabase/migrations/20261015130910_service_invoice_po_document_approval.sql",
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    const evidence = [{ sourcePage: 1, quote: "Website hosting service" }];
    const variants: unknown[] = [
      { kind: "services", evidence },
      { kind: "goods", evidence },
      { kind: "mixed", evidence },
      { kind: "unknown", evidence },
      undefined,
      { kind: "services", evidence: [] },
      { kind: "services", evidence: {} },
      { kind: "services", evidence: [{ sourcePage: 1, quote: " " }] },
      { kind: "services", evidence: [{ sourcePage: "1", quote: "Hosting" }] },
      { kind: "services", evidence: [{ sourcePage: 1.5, quote: "Hosting" }] },
      { kind: "services", evidence: [{ sourcePage: 0, quote: "Hosting" }] },
      { kind: "services", evidence: [...evidence, null] },
    ];
    for (const [index, nature] of variants.entries()) {
      const id = String(index);
      await db.query("insert into packet_cases values ($1,'completed')", [id]);
      await db.query(
        "insert into packet_documents values ($1,'Tax Invoice',$2)",
        [id, JSON.stringify({ __supplyNature: nature })],
      );
      const expected = isServiceOnlyPacket([
        { type: "Tax Invoice", supplyNature: nature as never },
      ]);
      if (expected)
        await db.query(
          "update packet_cases set status='accepted' where id=$1",
          [id],
        );
      else
        await assert.rejects(
          db.query("update packet_cases set status='accepted' where id=$1", [
            id,
          ]),
          /Purchase Order document/,
        );
      await db.query("update packet_cases set status='rejected' where id=$1", [
        id,
      ]);
    }
    for (const id of [
      "no-invoice",
      "mixed-packet",
      "material-with-po",
      "other-guard",
    ]) {
      await db.query("insert into packet_cases values ($1,'completed')", [id]);
    }
    await assert.rejects(
      db.exec(
        "update packet_cases set status='accepted' where id='no-invoice'",
      ),
      /Purchase Order document/,
    );
    await db.query(
      "insert into packet_documents values ('mixed-packet','Invoice',$1),('mixed-packet','Tax Invoice',$2),('other-guard','Invoice',$1)",
      [
        JSON.stringify({ __supplyNature: { kind: "services", evidence } }),
        JSON.stringify({ __supplyNature: { kind: "goods", evidence } }),
      ],
    );
    await assert.rejects(
      db.exec(
        "update packet_cases set status='accepted' where id='mixed-packet'",
      ),
      /Purchase Order document/,
    );
    await db.exec(
      "insert into packet_documents values ('material-with-po','Purchase Order','{}'); update packet_cases set status='accepted' where id='material-with-po'",
    );
    await assert.rejects(
      db.exec(
        "update packet_cases set status='accepted' where id='other-guard'",
      ),
      /Other approval check still enforced/,
    );
  } finally {
    await db.close();
  }
});
