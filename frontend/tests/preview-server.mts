/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic gateway rows represent several unrelated fixture tables. */
// Disposable, loopback-only fixtures for manual browser QA. NOT Supabase and NOT a production backend.
// Start with `node --import tsx tests/preview-server.mts`; Ctrl+C discards everything.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { samplePdf } from "./pdf-fixture.ts";
const owner = "00000000-0000-4000-8000-000000000001";
const expires = Math.floor(Date.now() / 1000) + 86400;
const token = [
  Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
  Buffer.from(
    JSON.stringify({ sub: owner, exp: expires, role: "authenticated" }),
  ).toString("base64url"),
  "fixture-signature",
].join(".");
const user = {
  id: owner,
  aud: "authenticated",
  role: "authenticated",
  email: "reviewer@example.invalid",
  is_anonymous: false,
  app_metadata: { provider: "email" },
  user_metadata: {},
  created_at: new Date().toISOString(),
};
const base = {
  owner_user_id: owner,
  slug: "sample-supplier",
  buyer_name: "Samrat Group",
  po_number: "PO-2026-041",
  invoice_number: "INV-084",
  risk_score: 20,
  upload_count: 2,
  document_count: 2,
  mismatch_count: 2,
  created_at: new Date().toISOString(),
  deleted_at: null,
  processing_meta: { caseCategory: "Procurement", draft: false },
};
const cases = [
  {
    ...base,
    id: "10000000-0000-4000-8000-000000000001",
    display_name: "Sample supplier · INV-084",
    status: "completed",
  },
  {
    ...base,
    id: "10000000-0000-4000-8000-000000000002",
    display_name: "Sample supplier · INV-083",
    status: "accepted",
    mismatch_count: 0,
    risk_score: 0,
  },
  {
    ...base,
    id: "10000000-0000-4000-8000-000000000003",
    display_name: "Sample draft case",
    status: "draft",
    document_count: 0,
    mismatch_count: 0,
    processing_meta: { draft: true },
  },
];
const files = cases.flatMap((c) =>
  ["invoice.pdf", "eway-bill.pdf"].map((name) => ({
    id: randomUUID(),
    case_id: c.id,
    original_name: name,
    storage_bucket: "packet-files",
    storage_path: name,
    mime_type: "application/pdf",
    size_bytes: samplePdf().byteLength,
    created_at: base.created_at,
  })),
);
const documents = cases
  .filter((c) => c.status !== "draft")
  .flatMap((c) => [
    {
      id: randomUUID(),
      client_document_id: "invoice-1",
      case_id: c.id,
      source_file_name: "invoice.pdf",
      source_hint: "invoice.pdf • Page 1",
      document_type: "Invoice",
      title: "Tax Invoice · INV-084",
      page_count: 1,
      extracted_fields: {
        invoiceNumber: "INV-084",
        referencePoNumber: "PO-2026-041",
        buyerName: "Samrat Group",
        vendorName: "Sample supplier",
        totalAmount: "118000",
        taxAmount: "18000",
        itemQuantity: "10",
        currency: "INR",
      },
      markdown: "Sample document used only for UI testing.",
      created_at: base.created_at,
    },
    {
      id: randomUUID(),
      client_document_id: "eway-1",
      case_id: c.id,
      source_file_name: "eway-bill.pdf",
      source_hint: "eway-bill.pdf • Page 1",
      document_type: "E-Way Bill",
      title: "E-Way Bill · EWB-041",
      page_count: 1,
      extracted_fields: {
        poNumber: "PO-2026-041",
        buyerName: "Samrat Group",
        vendorName: "Sample supplier",
        totalAmount: c.id === cases[0].id ? "120000" : "118000",
        itemQuantity: c.id === cases[0].id ? "12" : "10",
        currency: "INR",
      },
      markdown: "Sample e-way bill.",
      created_at: base.created_at,
    },
  ]);
const mismatches = [
  {
    id: "20000000-0000-4000-8000-000000000001",
    case_id: cases[0].id,
    client_mismatch_id: "issue-total",
    field_name: "totalAmount",
    values_json: [
      { docId: "invoice-1", value: "118000" },
      { docId: "eway-1", value: "120000" },
    ],
    analysis:
      "The invoice total is ₹118,000, while the e-way bill total is ₹120,000.",
    fix_plan:
      "Confirm the agreed amount against the original documents before accepting.",
    resolution_status: "pending",
    resolved_at: null,
    created_at: base.created_at,
  },
];
mismatches.push({
  ...mismatches[0],
  id: "20000000-0000-4000-8000-000000000002",
  client_mismatch_id: "issue-quantity",
  field_name: "itemQuantity",
  values_json: [
    { docId: "invoice-1", value: "10" },
    { docId: "eway-1", value: "12" },
  ],
  analysis: "The invoice lists 10 items; the e-way bill lists 12.",
  fix_plan: "Check the dispatched quantity.",
});
const tables: Record<string, any[]> = {
  packet_cases: cases,
  packet_case_files: files,
  packet_documents: documents,
  packet_mismatches: mismatches,
  packet_processing_jobs: [],
  field_settings: [],
  doc_type_settings: [
    { organization_id: "default", doc_type: "Bank Statement", enabled: false },
  ],
  comparison_field_groups: [],
  storage_assets: [],
};
const uploads = new Map<string, Buffer>();
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1:54329");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    let body: any = {};
    try {
      body = JSON.parse(bytes.toString() || "{}");
    } catch {}
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    res.setHeader("Access-Control-Expose-Headers", "Content-Range");
    function json(data: unknown, status = 200) {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/auth/v1/token") {
      if (
        url.searchParams.get("grant_type") === "password" &&
        (body.email !== "reviewer@example.invalid" ||
          body.password !== "local-fixture-only")
      ) {
        json({ message: "Invalid login credentials" }, 400);
        return;
      }
      json({
        access_token: token,
        refresh_token: "fixture-refresh",
        token_type: "bearer",
        expires_in: 86400,
        expires_at: expires,
        user,
      });
      return;
    }
    if (url.pathname === "/auth/v1/user") {
      json(user);
      return;
    }
    if (url.pathname === "/auth/v1/logout") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname.startsWith("/storage/v1/object/upload/sign/")) {
      const path = decodeURIComponent(
        url.pathname.replace(
          "/storage/v1/object/upload/sign/packet-files/",
          "",
        ),
      );
      if (req.method === "POST") {
        json({ url: `/object/upload/sign/packet-files/${path}?token=fixture` });
        return;
      }
      let uploadedBytes = bytes;
      if (String(req.headers["content-type"]).includes("multipart/form-data")) {
        const form = await new Response(bytes, {
          headers: { "Content-Type": String(req.headers["content-type"]) },
        }).formData();
        const file = [...form.values()].find((v) => v instanceof File);
        if (file instanceof File)
          uploadedBytes = Buffer.from(await file.arrayBuffer());
      }
      uploads.set(path, uploadedBytes);
      json({ Key: `packet-files/${path}` });
      return;
    }
    if (url.pathname.startsWith("/storage/v1/object/info/")) {
      const path = decodeURIComponent(
        url.pathname.replace("/storage/v1/object/info/packet-files/", ""),
      );
      json({
        name: path,
        size: uploads.get(path)?.byteLength || 0,
        content_type:
          tables.storage_assets.find((a) => a.storage_path === path)
            ?.mime_type || "application/pdf",
        last_modified: new Date().toISOString(),
      });
      return;
    }
    if (url.pathname.startsWith("/storage/v1/object/sign/")) {
      const path = decodeURIComponent(
        url.pathname.replace("/storage/v1/object/sign/packet-files/", ""),
      );
      if (req.method === "POST") {
        json({ signedURL: `/object/sign/packet-files/${path}?token=fixture` });
        return;
      }
      res.setHeader(
        "Content-Type",
        tables.storage_assets.find((a) => a.storage_path === path)?.mime_type ||
          "application/pdf",
      );
      res.end(uploads.get(path) || samplePdf());
      return;
    }
    if (url.pathname === "/.netlify/functions/process-case-background") {
      const job = tables.packet_processing_jobs.find(
        (j) => j.id === body.jobId,
      );
      if (job) {
        const c = cases.find((c) => c.id === job.case_id)!;
        job.status = "running";
        job.stage = "Extracting sample documents";
        job.progress = 40;
        setTimeout(() => {
          job.status = "succeeded";
          job.stage = "Completed";
          job.progress = 100;
          c.status = "completed";
          c.document_count = 1;
          c.processing_meta = {
            draft: false,
            caseCategory: "Procurement",
            ...job.result,
          };
          const file = files.find((f) => f.case_id === c.id)!;
          documents.push({
            ...documents[0],
            id: randomUUID(),
            case_id: c.id,
            source_file_name: file.original_name,
            source_hint: file.original_name,
          });
        }, 9000);
      }
      json({}, 202);
      return;
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const name = url.pathname.split("/").pop();
      if (name === "case_counts") {
        json({
          total: cases.filter((c) => !c.deleted_at).length,
          review: cases.filter((c) => c.status === "completed").length,
          processing: cases.filter((c) => c.status === "processing").length,
          accepted: cases.filter((c) => c.status === "accepted").length,
        });
        return;
      }
      if (name === "resolve_mismatches") {
        const selected = mismatches.filter(
          (m) => m.case_id === body.p_case && body.p_ids.includes(m.id),
        );
        selected.forEach((m) => {
          m.resolution_status = body.p_decision;
          m.resolved_at = new Date().toISOString() as any;
        });
        const c = cases.find((c) => c.id === body.p_case)!;
        c.status = mismatches
          .filter((m) => m.case_id === c.id)
          .every((m) => m.resolution_status === "accepted")
          ? "accepted"
          : "completed";
        json({
          caseStatus: c.status,
          mismatches: selected.map((m) => ({
            id: m.id,
            resolutionStatus: m.resolution_status,
            resolvedAt: m.resolved_at,
          })),
        });
        return;
      }
      if (name === "decide_case") {
        const c = cases.find((c) => c.id === body.p_case)!;
        if (body.p_action === "restore") c.deleted_at = null;
        else if (body.p_action === "recycle")
          c.deleted_at = new Date().toISOString() as any;
        else c.status = body.p_action === "accept" ? "accepted" : "rejected";
        json(c);
        return;
      }
      if (name === "reserve_upload") {
        tables.storage_assets.push({
          id: body.p_id,
          owner_user_id: body.p_user,
          storage_path: body.p_path,
          original_name: body.p_name,
          size_bytes: body.p_size,
          content_sha256: body.p_sha,
          mime_type: body.p_mime,
        });
        json(null);
        return;
      }
      if (name === "attach_case_uploads") {
        const asset = tables.storage_assets.filter((a) =>
          body.p_upload_ids.includes(a.id),
        );
        const signature = asset
          .map((a) => a.content_sha256)
          .sort()
          .join(",");
        if (!body.p_case_id && !body.p_allow_duplicate) {
          const duplicate = cases.find(
            (c) =>
              !c.deleted_at &&
              files
                .filter((f) => f.case_id === c.id)
                .map(
                  (f) =>
                    tables.storage_assets.find(
                      (a) => a.storage_path === f.storage_path,
                    )?.content_sha256 || "seed",
                )
                .sort()
                .join(",") === signature,
          );
          if (duplicate) {
            json({
              duplicateCase: {
                id: duplicate.id,
                displayName: duplicate.display_name,
                status: duplicate.status,
                createdAt: duplicate.created_at,
              },
            });
            return;
          }
        }
        let c = cases.find((c) => c.id === body.p_case_id);
        if (!c) {
          c = {
            ...base,
            id: randomUUID(),
            display_name: `Sample case · ${cases.length + 1}`,
            status: "draft",
            document_count: 0,
            mismatch_count: 0,
            upload_count: 0,
            processing_meta: { draft: true },
          };
          cases.push(c);
        }
        if (body.p_mode === "overwrite") {
          const names = new Set(
            asset.map((a) => a.original_name.toLowerCase()),
          );
          for (let i = files.length - 1; i >= 0; i--)
            if (
              files[i].case_id === c.id &&
              names.has(files[i].original_name.toLowerCase())
            )
              files.splice(i, 1);
        }
        files.push(
          ...asset.map((a) => ({
            id: randomUUID(),
            case_id: c!.id,
            original_name: a.original_name,
            storage_bucket: "packet-files",
            storage_path: a.storage_path,
            mime_type: a.mime_type,
            size_bytes: a.size_bytes,
            created_at: base.created_at,
          })),
        );
        c.upload_count = files.filter((f) => f.case_id === c!.id).length;
        json({ case: c });
        return;
      }
      if (name === "enqueue_case_analysis") {
        const c = cases.find((c) => c.id === body.p_case)!;
        c.status = "processing";
        const job = {
          id: randomUUID(),
          case_id: c.id,
          job_type: "case_analysis",
          status: "queued",
          attempt_count: 0,
          max_attempts: 2,
          progress: 0,
          stage: "Queued for review",
          result: body.p_options,
          created_at: base.created_at,
          updated_at: base.created_at,
          next_run_at: base.created_at,
        };
        tables.packet_processing_jobs.push(job);
        json({ case: c, job });
        return;
      }
      if (name === "save_review_settings") {
        tables.field_settings = body.p_fields.map((r: any) => ({
          ...r,
          organization_id: "default",
        }));
        tables.doc_type_settings = body.p_docs.map((r: any) => ({
          ...r,
          organization_id: "default",
        }));
        tables.comparison_field_groups = body.p_groups.map((g: any) => ({
          ...g,
          organization_id: "default",
          group_key: g.groupKey,
          sort_order: g.sortOrder,
        }));
        json(null);
        return;
      }
      json({ message: "Unsupported fixture RPC" }, 400);
      return;
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      const table = url.pathname.split("/").pop()!;
      let rows = [...(tables[table] || [])];
      for (const [key, value] of url.searchParams) {
        if (value.startsWith("eq."))
          rows = rows.filter((r) => String(r[key]) === value.slice(3));
        if (value === "is.null") rows = rows.filter((r) => r[key] == null);
        if (value === "not.is.null") rows = rows.filter((r) => r[key] != null);
        if (value.startsWith("in.("))
          rows = rows.filter((r) =>
            value.slice(4, -1).split(",").includes(String(r[key])),
          );
      }
      if (req.method === "PATCH") {
        rows.forEach((r) => Object.assign(r, body));
      }
      const orFilter = url.searchParams.get("or");
      if (orFilter) {
        const terms = [...orFilter.matchAll(/(\w+)\.ilike\.\*([^*]+)\*/g)];
        if (terms.length)
          rows = rows.filter((row) =>
            terms.some(([, key, term]) =>
              String(row[key] || "")
                .toLowerCase()
                .includes(term.toLowerCase()),
            ),
          );
      }
      const order = url.searchParams.get("order");
      if (order) {
        const [key, direction] = order.split(".");
        rows.sort(
          (a, b) =>
            String(a[key] || "").localeCompare(String(b[key] || "")) *
            (direction === "desc" ? -1 : 1),
        );
      }
      const total = rows.length;
      const offset = Number(url.searchParams.get("offset") || 0);
      rows = rows.slice(
        offset,
        offset + Number(url.searchParams.get("limit") || 500),
      );
      res.setHeader(
        "Content-Range",
        `${offset}-${offset + rows.length - 1}/${total}`,
      );
      json(
        String(req.headers.accept).includes("vnd.pgrst.object")
          ? rows[0] || null
          : rows,
      );
      return;
    }
    json({ error: "Unknown fixture endpoint" }, 404);
  } catch (e) {
    console.error(e);
    res.writeHead(500);
    res.end();
  }
});
server.listen(54329, "127.0.0.1", () =>
  console.log(
    "Disposable UI fixtures at http://127.0.0.1:54329 — no external services.",
  ),
);
