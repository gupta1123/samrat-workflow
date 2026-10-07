import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { refreshEWayBillValidityIssues } from "../src/server/eway-bill-validity";
import { buildAnalysisIntegrityRecord } from "../src/lib/analysis-integrity";

const meta = {
  extractionReview: { enabled: true, required: true, authoritative: true },
  analysisIntegrity: buildAnalysisIntegrityRecord({
    documentIds: ["bill"],
    documentAudits: [{ docId: "bill", status: "verified" }],
    pageQuality: [{ approvalSafe: true }],
  }),
};

test("live refresh adds expiry once and preserves accepted/rejected decisions", async () => {
  for (const decision of ["accepted", "rejected"]) {
    const saved = new Map<string, Record<string, unknown>>();
    let countUpdates = 0;
    const db = createClient("https://example.supabase.co", "test-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("packet_documents")) {
            assert.equal(url.searchParams.get("case_id"), "eq.case-1");
            return Response.json([
              {
                client_document_id: "bill",
                document_type: "E-Way Bill",
                title: "Bill",
                page_count: 1,
                extracted_fields: { validityDate: "06/10/2026" },
                source_file_name: "bill.pdf",
                markdown: "",
              },
            ]);
          }
          if (init?.method === "POST") {
            assert.ok(
              new Headers(init.headers)
                .get("prefer")
                ?.includes("resolution=ignore-duplicates"),
            );
            assert.equal(
              url.searchParams.get("on_conflict"),
              "case_id,client_mismatch_id",
            );
            const inserted = [];
            for (const issue of JSON.parse(String(init.body))) {
              if (!saved.has(issue.client_mismatch_id)) {
                saved.set(issue.client_mismatch_id, issue);
                inserted.push({ id: "mismatch-1" });
              }
            }
            return Response.json(inserted);
          }
          if (init?.method === "HEAD")
            return new Response(null, {
              headers: { "content-range": "0-0/1" },
            });
          if (init?.method === "PATCH") {
            countUpdates++;
            return new Response(null, { status: 204 });
          }
          throw new Error(
            `Unexpected request: ${init?.method} ${url.pathname}`,
          );
        },
      },
    });
    const row = { id: "case-1", status: "completed", processing_meta: meta };
    await refreshEWayBillValidityIssues(
      db,
      row,
      new Date("2026-10-07T07:00:00Z"),
    );
    assert.equal(saved.size, 1);
    const issue = [...saved.values()][0];
    issue.resolution_status = decision;
    issue.resolved_by = "reviewer";
    await refreshEWayBillValidityIssues(
      db,
      row,
      new Date("2026-10-08T07:00:00Z"),
    );
    assert.equal(saved.size, 1);
    assert.equal(issue.resolution_status, decision);
    assert.equal(issue.resolved_by, "reviewer");
    assert.equal(countUpdates, 1);
  }
});

test("no reads or writes for processing, unverified or already-approved cases", async () => {
  const db = createClient("https://example.supabase.co", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async () => {
        throw new Error("Must not query the database");
      },
    },
  });
  for (const status of ["draft", "processing", "accepted", "rejected"]) {
    await refreshEWayBillValidityIssues(db, {
      id: "case-1",
      status,
      processing_meta: meta,
    });
  }
  await refreshEWayBillValidityIssues(db, {
    id: "case-1",
    status: "completed",
    processing_meta: {},
  });
});
