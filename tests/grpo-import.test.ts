import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { grpoPdfAvailability } from "../src/server/sap/grpo-pdf-availability";
import { GET as listRoute } from "../src/app/api/sap-inspector/open-grpos/route";
import {
  POST as importRoute,
  DELETE as deleteImportRoute,
} from "../src/app/api/sap-inspector/grpos/[id]/import/route";
import {
  pdfAttachments,
  readBoundedPdf,
  grpoEntry,
} from "../src/server/sap/grpo-pdf";
import { importAssetId, grpoUploadStates } from "../src/server/sap/grpo-import";
import {
  fetchOpenReceiptSnapshot,
  importGrpoAndAnalyze,
  GrpoAnalysisStartError,
  recycleImportedGrpo,
} from "../src/lib/grpo-import-client";
import { createSupabaseAdminClient } from "../src/server/supabase/admin";
import { GrpoDraftBadge } from "../src/components/sap/GrpoDraftBadge";
import { zipFixture } from "./helpers/zip-fixture";

// Raw JSON rows in the mock PostgREST server deliberately have dynamic columns.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockRow = Record<string, any>;

const owner = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
const caseId = "33333333-3333-4333-8333-333333333333";
const jwt = (sub: string) =>
  [
    { alg: "HS256", typ: "JWT" },
    { sub, exp: Math.floor(Date.now() / 1000) + 3600, aud: "authenticated" },
  ]
    .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
    .join(".") + ".dGVzdA";
const digest = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
async function setup(t: TestContext) {
  const cfg = {
    SUPABASE_INTERNAL_URL: "https://store.invalid",
    SUPABASE_PUBLISHABLE_KEY: "public",
    SUPABASE_SERVICE_ROLE_KEY: "secret",
    SAP_SL_TEST_BASE_URL: "https://sap.invalid/b1s/v1",
    SAP_SL_TEST_COMPANY_DB: "COMPANY",
    SAP_SL_TEST_USERNAME: "user",
    SAP_SL_TEST_PASSWORD: "password",
    SAP_TEST_BASE_URL: "https://sap-api.invalid",
    SAP_TEST_USERNAME: "api-user",
    SAP_TEST_PASSWORD: "api-password",
    QUOTAGUARDSTATIC_URL: "",
  };
  const old = Object.fromEntries(
    Object.keys(cfg).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, cfg);
  const dispatcher = getGlobalDispatcher(),
    mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  t.after(async () => {
    setGlobalDispatcher(dispatcher);
    await mock.close();
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  const state = {
    closed: false,
    missing: false,
    badPdf: false,
    changedPdf: false,
    attachmentApiStatus: 200,
    attachmentApiCalls: [] as string[],
    failSave: false,
    failEvents: false,
    failDraftRead: false,
    assets: [] as MockRow[],
    events: [] as MockRow[],
    cases: [] as MockRow[],
    files: [] as MockRow[],
    postings: [] as MockRow[],
    postingReads: [] as URLSearchParams[],
    caseMutations: [] as MockRow[],
    objects: new Map<string, Buffer>(),
    sapWrites: [] as string[],
  };
  const listRows = [45, 44, 43, 42, 41].map((id) => ({
    DocEntry: id,
    DocNum: 100 + id,
    AttachmentEntry: id === 45 ? 9 : null,
    DocumentStatus: "bost_Open",
    Cancelled: "tNO",
    DocumentLines: [
      { LineNum: 0, ItemCode: "ITEM", Quantity: 5, RemainingOpenQuantity: 3 },
    ],
  }));
  const sap = mock.get("https://sap.invalid");
  sap
    .intercept({ path: "/b1s/v1/Login", method: "POST" })
    .reply(200, { SessionId: "session" })
    .persist();
  sap
    .intercept({ path: "/b1s/v1/Logout", method: "POST" })
    .reply(204)
    .persist();
  sap
    .intercept({ path: "/b1s/v1/PurchaseDeliveryNotes(42)", method: "GET" })
    .reply(() => ({
      statusCode: 200,
      data: JSON.stringify({
        DocEntry: 42,
        DocNum: 100,
        DocumentStatus: state.closed ? "bost_Close" : "bost_Open",
        Cancelled: "tNO",
        AttachmentEntry: 9,
      }),
    }))
    .persist();
  sap
    .intercept({ path: "/b1s/v1/Attachments2(9)", method: "GET" })
    .reply(() => ({
      statusCode: 200,
      data: JSON.stringify({
        Attachments2_Lines: [
          {
            FileName: "Original",
            FileExtension: state.missing ? "rpt" : "pdf",
          },
        ],
      }),
    }))
    .persist();
  mock
    .get("https://sbivan.samratgroup.com:5061")
    .intercept({
      path: "/api/Grpo/42/download-attachments",
      method: "GET",
      headers: {
        authorization: `Basic ${Buffer.from("api-user:api-password").toString("base64")}`,
      },
    })
    .reply((options) => {
      state.attachmentApiCalls.push(String(options.path));
      return {
        statusCode: state.attachmentApiStatus,
        data: zipFixture([
          {
            name: state.missing ? "Report.rpt" : "Original.pdf",
            bytes: state.badPdf
              ? Buffer.from("<html>not a PDF</html>")
              : state.changedPdf
                ? Buffer.concat([bytes, Buffer.from("\n% changed source")])
                : bytes,
          },
        ]),
        responseOptions: { headers: { "content-type": "application/zip" } },
      };
    })
    .persist();
  sap
    .intercept({ path: /^\/b1s\/v1\/Attachments2\?/, method: "GET" })
    .reply((options) => {
      const filter = new URL(
        String(options.path),
        "https://sap.invalid",
      ).searchParams.get("$filter");
      assert.ok(filter);
      return {
        statusCode: 200,
        data: JSON.stringify({
          value: filter.includes("AbsoluteEntry eq 9")
            ? [
                {
                  AbsoluteEntry: 9,
                  Attachments2_Lines: [
                    { FileName: "invoice", FileExtension: "pdf" },
                  ],
                },
              ]
            : [],
        }),
      };
    })
    .persist();
  sap
    .intercept({ path: /^\/b1s\/v1\/PurchaseDeliveryNotes\?/, method: "GET" })
    .reply((options) => {
      const url = new URL(String(options.path), "https://sap.invalid");
      const filter = url.searchParams.get("$filter") ?? "";
      assert.ok(filter.includes("DocumentStatus eq 'bost_Open'"));
      assert.ok(filter.includes("Cancelled eq 'tNO'"));
      const before = Number(/DocEntry lt (\d+)/.exec(filter)?.[1] ?? Infinity);
      const limit = Number(url.searchParams.get("$top") ?? 100);
      return {
        statusCode: 200,
        data: JSON.stringify({
          value: listRows
            .filter((r) => r.DocEntry < before)
            .slice(
              Number(url.searchParams.get("$skip") ?? 0),
              Number(url.searchParams.get("$skip") ?? 0) + limit,
            ),
        }),
      };
    })
    .persist();
  const matches = (row: MockRow, params: URLSearchParams) =>
    [...params].every(([key, v]) => {
      if (key === "select" || key === "order" || key === "limit") return true;
      let actual = row as MockRow;
      for (const part of key.replaceAll(".", "->>").split("->>"))
        actual = actual?.[part];
      if (v.startsWith("eq.")) return String(actual) === v.slice(3);
      if (v.startsWith("in.("))
        return v
          .slice(4, -1)
          .split(",")
          .map((x) => x.replaceAll('"', ""))
          .includes(String(actual));
      if (v === "is.null") return actual === null;
      if (v.startsWith("cs.")) {
        const sub = JSON.parse(v.slice(3));
        return Object.entries(sub).every(([k, x]) => actual?.[k] === x);
      }
      return true;
    });
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      assert.equal(
        url.origin,
        "https://store.invalid",
        "Tests must not access real services",
      );
      const method = init.method ?? "GET";
      const body =
        typeof init.body === "string" && init.body.startsWith("{")
          ? JSON.parse(init.body)
          : null;
      if (url.pathname === "/auth/v1/user")
        return Response.json({
          id: owner,
          aud: "authenticated",
          role: "authenticated",
        });
      if (url.pathname === "/rest/v1/rpc/reserve_upload") {
        if (state.assets.some((a) => a.id === body.p_id))
          return Response.json(
            { code: "23505", message: "duplicate" },
            { status: 409 },
          );
        state.assets.push({
          id: body.p_id,
          owner_user_id: body.p_user,
          storage_path: body.p_path,
          original_name: body.p_name,
          content_sha256: body.p_sha,
          size_bytes: body.p_size,
          mime_type: body.p_mime,
          page_count: null,
        });
        return Response.json(null);
      }
      if (url.pathname === "/rest/v1/rpc/attach_case_uploads") {
        assert.equal(body.p_allow_duplicate, false);
        const assets = state.assets.filter((a) =>
          body.p_upload_ids.includes(a.id),
        );
        let active = state.cases.find(
          (c) => c.owner_user_id === body.p_user && !c.deleted_at,
        );
        if (!active) {
          active = {
            id: state.cases.length
              ? "55555555-5555-4555-8555-555555555555"
              : caseId,
            status: "draft",
            deleted_at: null,
            owner_user_id: owner,
          };
          state.cases.push(active);
          for (const a of assets) {
            a.consumed_case_id = active.id;
            state.files.push({
              case_id: active.id,
              content_sha256: a.content_sha256,
            });
          }
        }
        return Response.json({ case: active });
      }
      if (url.pathname === "/rest/v1/rpc/decide_case") {
        assert.equal(body.p_action, "recycle");
        const c = state.cases.find(
          (c) => c.id === body.p_case && c.owner_user_id === body.p_user,
        );
        assert.ok(c, "Only an owned imported case can be recycled");
        state.caseMutations.push(body);
        c.deleted_at = new Date().toISOString();
        return Response.json(c);
      }
      if (url.pathname.startsWith("/storage/v1/object/")) {
        const path = decodeURIComponent(url.pathname).replace(
          /^\/storage\/v1\/object\/(authenticated\/)?packet-files\//,
          "",
        );
        if (method === "POST") {
          if (state.failSave)
            return Response.json({ message: "Unavailable" }, { status: 503 });
          if (state.objects.has(path))
            return Response.json(
              { message: "Already exists" },
              { status: 409 },
            );
          state.objects.set(path, Buffer.from(init.body as Uint8Array));
          return Response.json({ Key: path });
        }
        const value = state.objects.get(path);
        return value
          ? new Response(Uint8Array.from(value).buffer)
          : Response.json({ message: "missing" }, { status: 404 });
      }
      const table = url.pathname.split("/").at(-1);
      if (table === "sap_postings") {
        assert.equal(method, "GET", "Draft status must be read-only");
        state.postingReads.push(url.searchParams);
        if (state.failDraftRead)
          return Response.json({ message: "Unavailable" }, { status: 500 });
      }
      const rows =
        table === "storage_assets"
          ? state.assets
          : table === "packet_cases"
            ? state.cases
            : table === "packet_case_files"
              ? state.files
              : table === "case_review_events"
                ? state.events
                : table === "sap_postings"
                  ? state.postings
                  : null;
      assert.ok(rows, `Unexpected data call ${url}`);
      const visible: MockRow[] =
        table === "packet_case_files" &&
        url.searchParams.get("select")?.includes("!inner")
          ? rows.map((r) => ({
              ...r,
              packet_cases: state.cases.find((c) => c.id === r.case_id),
            }))
          : rows;
      const selected = visible
        .filter((r) => matches(r, url.searchParams))
        .map((r) =>
          table === "sap_postings"
            ? {
                case_id: r.case_id,
                status: r.status,
                sap_docnum: r.sap_docnum,
                documentType: r.payload?.documentType,
                docEntry: r.response?.DocEntry,
                draftDocEntry: r.response?.DraftDocEntry,
                docNum: r.response?.DocNum,
              }
            : r,
        );
      if (method === "PATCH") {
        for (const r of selected) Object.assign(r, body);
        return new Response(null, { status: 204 });
      }
      if (method === "POST") {
        if (state.failEvents)
          return Response.json(
            { message: "temporarily unavailable" },
            { status: 503 },
          );
        rows.push(body);
        return new Response(null, { status: 201 });
      }
      const accept = new Headers(init.headers).get("accept") ?? "";
      return Response.json(
        accept.includes("object+json") ? (selected[0] ?? null) : selected,
      );
    },
  );
  const call = (body: Record<string, unknown>, user = owner) =>
    importRoute(
      new Request("https://app.invalid/api/sap-inspector/grpos/42/import", {
        method: "POST",
        headers: {
          Origin: "https://app.invalid",
          Authorization: "Bearer " + jwt(user),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: "42" }) },
    );
  const session = async () => {
    const r = await call({ action: "prepare" });
    assert.equal(r.status, 200);
    return r.json();
  };
  return { state, bytes, call, session, listRows };
}

test("SAP import stores the original bytes, validates pages, attaches once and reports uploaded", async (t) => {
  const { state, bytes, call, session } = await setup(t);
  const s = await session();
  assert.equal(s.files.length, 1);
  const saved = await call({ ...s, action: "file", index: 0 });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).sha256, digest(bytes));
  assert.equal(state.assets[0].page_count, 1);
  const done = await call({ ...s, action: "finish" });
  assert.equal(done.status, 200);
  assert.equal((await done.json()).caseId, caseId);
  assert.equal(state.cases.length, 1);
  assert.deepEqual([...state.objects.values()][0], bytes);
  assert.ok(state.attachmentApiCalls.length >= 3);
  assert.ok(
    state.attachmentApiCalls.every(
      (path) => path === "/api/Grpo/42/download-attachments",
    ),
  );
  assert.equal(state.events[0].details.environment, "test");
  const again = await call({ ...s, action: "finish" });
  assert.equal(again.status, 200);
  assert.equal(state.cases.length, 1);
  const states = await grpoUploadStates(
    createSupabaseAdminClient(),
    owner,
    "COMPANY",
    [{ docEntry: "42" }],
  );
  assert.equal(states[42].caseId, caseId);
});

test("missing or non-PDF attachments and closed GRPOs create no uploads", async (t) => {
  const { state, call } = await setup(t);
  state.missing = true;
  assert.equal((await call({ action: "prepare" })).status, 404);
  state.closed = true;
  assert.equal((await call({ action: "prepare" })).status, 409);
  assert.equal(state.assets.length, 0);
});

test("an HTML download is rejected before reserving storage", async (t) => {
  const { state, call, session } = await setup(t);
  const s = await session();
  state.badPdf = true;
  assert.equal((await call({ ...s, action: "file", index: 0 })).status, 502);
  assert.equal(state.assets.length, 0);
});

test("changed PDF bytes under the same filename invalidate the import manifest", async (t) => {
  const { state, call, session } = await setup(t);
  const s = await session();
  state.changedPdf = true;
  assert.equal((await call({ ...s, action: "file", index: 0 })).status, 409);
  assert.equal(state.assets.length, 0);
  assert.equal(state.cases.length, 0);
});

test("attachment API failures cannot fall back to a different PDF source", async (t) => {
  const { state, call } = await setup(t);
  state.attachmentApiStatus = 401;
  assert.equal((await call({ action: "prepare" })).status, 502);
  state.attachmentApiStatus = 404;
  assert.equal((await call({ action: "prepare" })).status, 404);
  assert.equal(state.assets.length, 0);
  assert.equal(state.cases.length, 0);
});

test("GRPO downloads retain Test credentials even when the general SAP environment is live", async (t) => {
  const prior = process.env.SAP_API_ENV;
  t.after(() => {
    if (prior === undefined) delete process.env.SAP_API_ENV;
    else process.env.SAP_API_ENV = prior;
  });
  process.env.SAP_API_ENV = "live";
  const { state, session } = await setup(t);
  await session();
  assert.deepEqual(state.attachmentApiCalls, ["/api/Grpo/42/download-attachments"]);
  assert.equal(state.cases.length, 0);
});

test("changed manifests, invalid indexes and other users' assets cannot be imported", async (t) => {
  const { state, call, session } = await setup(t);
  const s = await session();
  assert.equal(
    (await call({ ...s, manifest: "changed", action: "file", index: 0 }))
      .status,
    409,
  );
  assert.equal((await call({ ...s, action: "file", index: 99 })).status, 400);
  state.assets.push({
    id: importAssetId(owner, "COMPANY", 42, s.day, 0, s.session),
    owner_user_id: other,
    storage_path: "other/private.pdf",
  });
  assert.equal((await call({ ...s, action: "file", index: 0 })).status, 409);
  assert.equal(state.objects.size, 0);
});

test("partial uploads cannot create a case; retrying a saved file is idempotent", async (t) => {
  const { state, call, session } = await setup(t);
  const s = await session();
  assert.equal((await call({ ...s, action: "finish" })).status, 404);
  await call({ ...s, action: "file", index: 0 });
  await call({ ...s, action: "file", index: 0 });
  assert.equal(state.assets.length, 1);
  assert.equal(state.objects.size, 1);
  assert.equal(state.cases.length, 0);
});

test("uploaded state respects company, owner, recycle bin and removed source files", async (t) => {
  const { state, call, session } = await setup(t);
  const s = await session();
  await call({ ...s, action: "file", index: 0 });
  await call({ ...s, action: "finish" });
  const db = createSupabaseAdminClient();
  assert.deepEqual(
    await grpoUploadStates(db, other, "COMPANY", [{ docEntry: "42" }]),
    {},
  );
  assert.deepEqual(
    await grpoUploadStates(db, owner, "ANOTHER", [{ docEntry: "42" }]),
    {},
  );
  state.cases[0].deleted_at = "2026-01-01";
  assert.equal(
    (await grpoUploadStates(db, owner, "COMPANY", [{ docEntry: "42" }]))[42]
      .deleted,
    true,
  );
  state.files = [];
  assert.deepEqual(
    await grpoUploadStates(db, owner, "COMPANY", [{ docEntry: "42" }]),
    {},
  );
});

async function draftStatusFixture(t: TestContext) {
  const result = await setup(t);
  const sha = digest(result.bytes);
  result.state.cases.push({
    id: caseId,
    owner_user_id: owner,
    status: "accepted",
    deleted_at: null,
  });
  result.state.files.push({ case_id: caseId, content_sha256: sha });
  result.state.events.push({
    case_id: caseId,
    owner_user_id: owner,
    action: "sap_grpo_pdf_imported",
    details: {
      company: "COMPANY",
      environment: "test",
      docEntry: 42,
      sha256s: [sha],
    },
  });
  const posting = {
    case_id: caseId,
    owner_user_id: owner,
    kind: "AP",
    sap_env: "test",
    status: "prepared",
    sap_docnum: "237615",
    payload: { documentType: "APInvoiceDraft" },
    response: { DocEntry: 237615, DocNum: 813 },
  };
  const read = () =>
    grpoUploadStates(createSupabaseAdminClient(), owner, "COMPANY", [
      { docEntry: "42" },
    ]);
  return { ...result, posting, read };
}

test("uploaded API reports the confirmed SAP draft and number, separately from case status", async (t) => {
  const { state, posting, read } = await draftStatusFixture(t);
  assert.deepEqual((await read())[42].sapDraft, { status: "not_created" });
  state.cases[0].status = "draft";
  assert.deepEqual((await read())[42].sapDraft, { status: "not_created" });
  state.postings.push(posting);
  const response = await listRoute(
    new Request(
      "https://app.invalid/api/sap-inspector/open-grpos?uploaded=yes",
      { headers: { Authorization: "Bearer " + jwt(owner) } },
    ),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.uploads[42].sapDraft, {
    status: "created",
    docEntry: "237615",
    docNum: "813",
  });
  assert.equal(state.sapWrites.length, 0);
});

test("draft badges use only the linked owner's Test AP posting and never expose unrelated drafts", async (t) => {
  const { state, posting, read } = await draftStatusFixture(t);
  state.postings.push(
    { ...posting, owner_user_id: other },
    { ...posting, sap_env: "live" },
    { ...posting, kind: "GRN" },
    { ...posting, case_id: "44444444-4444-4444-8444-444444444444" },
  );
  assert.deepEqual((await read())[42].sapDraft, { status: "not_created" });
  assert.equal(state.postingReads.length, 1);
  const query = state.postingReads[0];
  assert.equal(query.get("owner_user_id"), `eq.${owner}`);
  assert.equal(query.get("sap_env"), "eq.test");
  assert.equal(query.get("kind"), "eq.AP");
  assert.equal(query.get("case_id"), `in.(${caseId})`);
  assert.ok(
    !query.get("select")?.split(",").includes("payload"),
    "Do not fetch saved invoice contents for a badge",
  );
});

test("unavailable or incomplete draft records do not falsely say Not drafted or Draft created", async (t) => {
  const { state, posting, read } = await draftStatusFixture(t);
  state.failDraftRead = true;
  assert.deepEqual((await read())[42].sapDraft, { status: "unavailable" });
  state.failDraftRead = false;
  state.postings.push({
    ...posting,
    sap_docnum: null,
    response: { DocEntry: 0 },
  });
  assert.deepEqual((await read())[42].sapDraft, { status: "unavailable" });
  state.postings[0] = { ...posting, payload: { documentType: "APInvoice" } };
  assert.deepEqual((await read())[42].sapDraft, { status: "unavailable" });
  state.postings[0] = { ...posting, response: {} };
  assert.deepEqual((await read())[42].sapDraft, {
    status: "created",
    docEntry: "237615",
    docNum: undefined,
  });
});

test("failed attempts are not drafts and historical posted invoices stay distinct", async (t) => {
  const { state, posting, read } = await draftStatusFixture(t);
  for (const status of ["failed", "blocked"]) {
    state.postings[0] = { ...posting, status };
    assert.deepEqual((await read())[42].sapDraft, { status: "not_created" });
  }
  state.postings[0] = {
    ...posting,
    status: "posted",
    payload: { documentType: "APInvoice" },
  };
  assert.deepEqual((await read())[42].sapDraft, { status: "posted" });
});

test("draft badge displays a SAP number and keeps unavailable distinct from not drafted", () => {
  const render = (draft?: Parameters<typeof GrpoDraftBadge>[0]["draft"]) =>
    renderToStaticMarkup(createElement(GrpoDraftBadge, { draft }));
  assert.match(
    render({ status: "created", docEntry: "237615", docNum: "813" }),
    /Draft created · 813/,
  );
  assert.match(
    render({ status: "created", docEntry: "237615" }),
    /Draft created · 237615/,
  );
  assert.match(render({ status: "not_created" }), />Not drafted</);
  assert.match(render({ status: "posted" }), />Invoice posted</);
  assert.match(render(), />Draft status unavailable</);
});

function deleteReceipt(
  caseToDelete = caseId,
  headers: Record<string, string> = {},
) {
  return deleteImportRoute(
    new Request("https://app.invalid/api/sap-inspector/grpos/42/import", {
      method: "DELETE",
      headers: {
        Authorization: "Bearer " + jwt(owner),
        Origin: "https://app.invalid",
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ caseId: caseToDelete }),
    }),
    { params: Promise.resolve({ id: "42" }) },
  );
}

test("delete uploaded receipt rechecks the draft and moves only its case to Recycle Bin", async (t) => {
  const { state, read } = await draftStatusFixture(t);
  const result = await deleteReceipt();
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { caseId, deleted: true });
  assert.equal(state.caseMutations.length, 1);
  assert.equal((await read())[42].deleted, true);
  assert.equal(state.files.length, 1, "Soft deletion preserves source files");
  assert.equal(state.sapWrites.length, 0);
  assert.equal((await deleteReceipt()).status, 200);
  assert.equal(
    state.caseMutations.length,
    1,
    "A repeated confirmation is idempotent",
  );
});

test("a newly saved SAP draft, a posted invoice, or an unavailable check blocks stale delete clicks", async (t) => {
  const { state, posting, read } = await draftStatusFixture(t);
  assert.equal((await read())[42].sapDraft?.status, "not_created");
  state.postings.push(posting);
  assert.equal((await deleteReceipt()).status, 409);
  state.postings[0].status = "posted";
  assert.equal((await deleteReceipt()).status, 409);
  state.postings = [];
  state.failDraftRead = true;
  assert.equal((await deleteReceipt()).status, 409);
  assert.equal(state.caseMutations.length, 0);
  assert.equal(state.cases[0].deleted_at, null);
});

test("deletion rejects processing, changed, unlinked, cross-account and cross-origin cases", async (t) => {
  const { state } = await draftStatusFixture(t);
  state.cases[0].status = "processing";
  assert.equal((await deleteReceipt()).status, 409);
  state.cases[0].status = "completed";
  assert.equal(
    (await deleteReceipt("44444444-4444-4444-8444-444444444444")).status,
    409,
  );
  assert.ok(
    [401, 403].includes(
      (await deleteReceipt(caseId, { Origin: "https://foreign.invalid" }))
        .status,
    ),
  );
  assert.ok(
    [401, 403].includes(
      (await deleteReceipt(caseId, { Authorization: "Basic invalid" })).status,
    ),
  );
  state.cases[0].owner_user_id = other;
  assert.equal((await deleteReceipt()).status, 409);
  state.cases[0].owner_user_id = owner;
  state.files = [];
  assert.equal((await deleteReceipt()).status, 409);
  assert.equal(state.caseMutations.length, 0);
});

test("delete client only accepts a confirmed recycled case and reports server rejection", async () => {
  await recycleImportedGrpo("42", caseId, async (url, init) => {
    assert.equal(url, "/api/sap-inspector/grpos/42/import");
    assert.equal(init?.method, "DELETE");
    assert.deepEqual(JSON.parse(String(init?.body)), { caseId });
    return Response.json({ caseId, deleted: true });
  });
  await assert.rejects(
    () =>
      recycleImportedGrpo("42", caseId, async () =>
        Response.json({ error: "Draft already saved" }, { status: 409 }),
      ),
    /Draft already saved/,
  );
  await assert.rejects(
    () => recycleImportedGrpo("42", caseId, async () => Response.json({})),
    /Deletion could not be confirmed/,
  );
});

test("oversized or incomplete PDFs are rejected and attachment selection preserves SAP filenames", async () => {
  assert.deepEqual(
    pdfAttachments(2, [
      { FileName: "report", FileExtension: "rpt" },
      { FileName: "a'b", FileExtension: "PDF" },
    ]),
    [{ attachmentEntry: 2, name: "a'b.PDF", index: 0 }],
  );
  assert.throws(() =>
    pdfAttachments(2, [{ FileName: "../escape", FileExtension: "pdf" }]),
  );
  assert.throws(() => grpoEntry("-1"));
  await assert.rejects(
    readBoundedPdf(
      new Response("%PDF-a", {
        headers: { "content-length": String(51 * 1024 * 1024) },
      }),
    ),
    /50 MB/,
  );
  await assert.rejects(
    readBoundedPdf(new Response("<html>")),
    /did not return a PDF/,
  );
});

test("client completes every PDF before creating a case and starting analysis", async () => {
  const calls: string[] = [];
  const progress: string[] = [];
  const fetcher = async (_input: string, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body));
    calls.push(b.action + (b.index ?? ""));
    return Response.json(
      b.action === "prepare"
        ? {
            files: [{ index: 0 }, { index: 1 }],
            day: "2026-11-10",
            manifest: "verified",
            session: "uuid",
          }
        : b.action === "finish"
          ? { caseId, status: "draft" }
          : { id: "saved" },
    );
  };
  const enqueue = async (id: string) => {
    assert.equal(id, caseId);
    calls.push("analysis");
    return {} as never;
  };
  const result = await importGrpoAndAnalyze("42", (s) => progress.push(s), {
    fetcher,
    enqueue,
  });
  assert.deepEqual(calls, ["prepare", "file0", "file1", "finish", "analysis"]);
  assert.equal(result.status, "processing");
  assert.ok(progress.some((p) => p.includes("2 of 2")));
});

test("client never starts analysis after download failure and exposes saved-case queue failures", async () => {
  let queued = false;
  const enqueue = async () => {
    queued = true;
    throw Error("queue down");
  };
  let fail = true;
  const fetcher = async (_input: string, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body));
    return Response.json(
      b.action === "prepare"
        ? {
            files: [{ index: 0 }],
            day: "today",
            manifest: "source",
            session: "uuid",
          }
        : fail
          ? { error: "Download failed" }
          : { caseId, status: "draft" },
      { status: b.action === "file" && fail ? 502 : 200 },
    );
  };
  await assert.rejects(
    importGrpoAndAnalyze("42", () => {}, { fetcher, enqueue }),
    /Download failed/,
  );
  assert.equal(queued, false);
  fail = false;
  await assert.rejects(
    importGrpoAndAnalyze("42", () => {}, { fetcher, enqueue }),
    GrpoAnalysisStartError,
  );
  assert.equal(queued, true);
});

test("lost audit response or simultaneous imports still reuse one exact-content case", async (t) => {
  const { state, call, session } = await setup(t);
  const first = await session(),
    second = await session();
  for (const s of [first, second])
    assert.equal((await call({ ...s, action: "file", index: 0 })).status, 200);
  state.failEvents = true;
  assert.equal((await call({ ...first, action: "finish" })).status, 500);
  assert.equal(state.cases.length, 1);
  state.failEvents = false;
  assert.equal((await call({ ...second, action: "finish" })).status, 200);
  assert.equal(state.cases.length, 1);
  assert.equal(
    (
      await grpoUploadStates(createSupabaseAdminClient(), owner, "COMPANY", [
        { docEntry: "42" },
      ])
    )[42].caseId,
    caseId,
  );
});

test("unauthenticated or cross-origin requests cannot trigger a SAP import", async (t) => {
  const { state } = await setup(t);
  for (const headers of [
    {
      "Content-Type": "application/json",
      Authorization: "invalid",
      Origin: "https://app.invalid",
    },
    {
      Authorization: "Bearer " + jwt(owner),
      Origin: "https://foreign.invalid",
      "Content-Type": "application/json",
    },
  ]) {
    const r = await importRoute(
      new Request("https://app.invalid/api/sap-inspector/grpos/42/import", {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "prepare" }),
      }),
      { params: Promise.resolve({ id: "42" }) },
    );
    assert.ok([401, 403].includes(r.status));
  }
  assert.equal(state.assets.length, 0);
});

test("existing completed cases are opened without re-running analysis", async () => {
  let queued = false;
  const fetcher = async () =>
    Response.json({ caseId, status: "completed", existing: true });
  const enqueue = async () => {
    queued = true;
    return {} as never;
  };
  const result = await importGrpoAndAnalyze("42", () => {}, {
    fetcher,
    enqueue,
  });
  assert.equal(queued, false);
  assert.equal(result.caseId, caseId);
});

test("tabs filter on the server and keep accurate cursors across sparse uploaded results", async (t) => {
  const { call, session } = await setup(t);
  const s = await session();
  await call({ ...s, action: "file", index: 0 });
  await call({ ...s, action: "finish" });
  const list = async (query: string) => {
    const r = await listRoute(
      new Request(
        "https://app.invalid/api/sap-inspector/open-grpos?limit=2&" + query,
        { headers: { Authorization: "Bearer " + jwt(owner) } },
      ),
    );
    assert.equal(r.status, 200);
    return r.json();
  };
  const uploaded = await list("uploaded=yes");
  assert.deepEqual(
    uploaded.records.map((r: { docEntry: string }) => r.docEntry),
    ["42"],
  );
  assert.equal(uploaded.uploads[42].caseId, caseId);
  assert.equal(uploaded.nextCursor, null);
  const first = await list("uploaded=no");
  assert.deepEqual(
    first.records.map((r: { docEntry: string }) => r.docEntry),
    ["45", "44"],
  );
  assert.equal(first.nextCursor, 44);
  assert.equal(first.pdfs[45].status, "available");
  assert.equal(first.pdfs[44].status, "missing");
  const second = await list("uploaded=no&before=44");
  assert.deepEqual(
    second.records.map((r: { docEntry: string }) => r.docEntry),
    ["43", "41"],
  );
  assert.equal(second.nextCursor, null);
});

test("recycled receipts move to Not uploaded with fresh PDF availability; restoring moves them back", async (t) => {
  const { state, call, session, listRows } = await setup(t);
  listRows.find((row) => row.DocEntry === 42)!.AttachmentEntry = 9;
  const s = await session();
  await call({ ...s, action: "file", index: 0 });
  await call({ ...s, action: "finish" });
  const read = async (tab: string) => {
    const r = await listRoute(
      new Request(
        `https://app.invalid/api/sap-inspector/open-grpos?uploaded=${tab}&limit=100`,
        { headers: { Authorization: "Bearer " + jwt(owner) } },
      ),
    );
    assert.equal(r.status, 200);
    return r.json();
  };
  assert.equal((await read("yes")).uploads[42].caseId, caseId);
  assert.equal((await deleteReceipt()).status, 200);
  assert.deepEqual((await read("yes")).records, []);
  const notUploaded = await read("no");
  assert.ok(
    notUploaded.records.some(
      (row: { docEntry: string }) => row.docEntry === "42",
    ),
  );
  assert.equal(
    notUploaded.uploads[42],
    undefined,
    "A recycled case must not render as an active uploaded case",
  );
  assert.equal(notUploaded.pdfs[42].status, "available");
  assert.equal(state.files.length, 1);
  state.cases[0].deleted_at = null;
  assert.equal((await read("yes")).uploads[42].caseId, caseId);
  assert.ok(
    !(await read("no")).records.some(
      (row: { docEntry: string }) => row.docEntry === "42",
    ),
  );
});

test("download after recycling revalidates SAP and creates a fresh case without restoring the old case", async (t) => {
  const { state, bytes, call, session } = await setup(t);
  const first = await session();
  await call({ ...first, action: "file", index: 0 });
  await call({ ...first, action: "finish" });
  assert.equal((await deleteReceipt()).status, 200);
  state.closed = true;
  assert.equal(
    (await call({ action: "prepare" })).status,
    409,
    "A recycled case must not bypass the current SAP open check",
  );
  state.closed = false;
  const fresh = await session();
  assert.equal(fresh.caseId, undefined);
  assert.equal(fresh.files.length, 1);
  assert.notEqual(fresh.session, first.session);
  assert.equal(
    (await call({ ...fresh, action: "file", index: 0 })).status,
    200,
  );
  const finished = await call({ ...fresh, action: "finish" });
  assert.equal(finished.status, 200);
  const result = await finished.json();
  assert.notEqual(result.caseId, caseId);
  assert.equal(state.cases.length, 2);
  assert.ok(state.cases[0].deleted_at);
  assert.equal(state.cases[1].deleted_at, null);
  assert.equal(state.files.filter((file) => file.case_id === caseId).length, 1);
  assert.ok([...state.objects.values()].every((value) => value.equals(bytes)));
  const states = await grpoUploadStates(
    createSupabaseAdminClient(),
    owner,
    "COMPANY",
    [{ docEntry: "42" }],
  );
  assert.equal(states[42].caseId, result.caseId);
  assert.equal(states[42].deleted, false);
  let queued: string | null = null;
  await importGrpoAndAnalyze("42", () => {}, {
    fetcher: (_url, init) => call(JSON.parse(String(init?.body))),
    enqueue: async (id) => {
      queued = id;
      return {} as never;
    },
  });
  assert.equal(queued, result.caseId);
  assert.equal(state.cases.length, 2);
});

test("a manual case with the identical PDF and extra documents is reused", async (t) => {
  const { state, bytes, call, session } = await setup(t);
  state.cases.push({
    id: caseId,
    status: "completed",
    deleted_at: null,
    owner_user_id: owner,
  });
  state.files.push(
    { case_id: caseId, content_sha256: digest(bytes) },
    { case_id: caseId, content_sha256: "extra-document" },
  );
  const s = await session();
  await call({ ...s, action: "file", index: 0 });
  const r = await call({ ...s, action: "finish" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, "completed");
  assert.equal(state.cases.length, 1);
  assert.equal(state.events.length, 1);
});

test("PDF badges distinguish confirmed missing files from unavailable metadata", async () => {
  const records = [null, -1, undefined, 1, 2, 3].map((entry, i) => ({
    docEntry: String(i),
    raw: { AttachmentEntry: entry },
  }));
  const result = await grpoPdfAvailability(records, async (entry) => {
    if (entry === 3) throw Error("SAP unavailable");
    return {
      Attachments2_Lines: [
        { FileName: "source", FileExtension: entry === 1 ? "pdf" : "rpt" },
      ],
    };
  });
  assert.equal(result[0].status, "missing");
  assert.equal(result[1].status, "missing");
  assert.equal(result[2].status, "unavailable");
  assert.equal(result[3].status, "available");
  assert.equal(result[4].status, "missing");
  assert.equal(result[5].status, "unavailable");
});

test("attachment checks share repeated SAP reads and bound concurrency", async () => {
  let active = 0,
    max = 0,
    calls = 0;
  const result = await grpoPdfAvailability(
    Array.from({ length: 12 }, (_, i) => ({
      docEntry: String(i),
      raw: { AttachmentEntry: 1 + Math.floor(i / 2) },
    })),
    async () => {
      calls++;
      active++;
      max = Math.max(max, active);
      await Promise.resolve();
      active--;
      return {
        Attachments2_Lines: [{ FileName: "invoice", FileExtension: "pdf" }],
      };
    },
  );
  assert.equal(calls, 6);
  assert.ok(max <= 4);
  assert.equal(Object.keys(result).length, 12);
  assert.ok(Object.values(result).every((v) => v.status === "available"));
});

test("receipt list defaults to ten receipts and continues without dropping records", async (t) => {
  const { listRows } = await setup(t);
  for (let id = 40; id >= 30; id--)
    listRows.push({
      DocEntry: id,
      DocNum: 100 + id,
      DocumentStatus: "bost_Open",
      Cancelled: "tNO",
      AttachmentEntry: null,
      DocumentLines: [
        { LineNum: 0, ItemCode: "ITEM", Quantity: 5, RemainingOpenQuantity: 3 },
      ],
    });
  const read = async (before?: number) => {
    const r = await listRoute(
      new Request(
        "https://app.invalid/api/sap-inspector/open-grpos?uploaded=no" +
          (before ? `&before=${before}` : ""),
        { headers: { Authorization: "Bearer " + jwt(owner) } },
      ),
    );
    assert.equal(r.status, 200);
    return r.json();
  };
  const first = await read();
  assert.equal(first.records.length, 10);
  assert.equal(first.nextCursor, 36);
  const second = await read(first.nextCursor);
  assert.equal(second.records.length, 6);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.records, ...second.records].map((r) => r.docEntry)).size,
    16,
  );
});

test("the receipt snapshot loads both tabs across SAP batches before returning", async (t) => {
  const { call, session, listRows } = await setup(t);
  const s = await session();
  await call({ ...s, action: "file", index: 0 });
  await call({ ...s, action: "finish" });
  for (let id = 80; id >= 1; id--) {
    if (id >= 41 && id <= 45) continue;
    listRows.push({
      ...listRows[0],
      DocEntry: id,
      DocNum: 100 + id,
      AttachmentEntry: id === 1 ? 10 : null,
    });
  }
  listRows.sort((a, b) => b.DocEntry - a.DocEntry);
  const requestedCursors: Array<string | null> = [];
  const progress: number[] = [];
  const snapshot = await fetchOpenReceiptSnapshot(
    new AbortController().signal,
    (count) => progress.push(count),
    async (path, init) => {
      const url = new URL(path, "https://app.invalid");
      requestedCursors.push(url.searchParams.get("before"));
      return listRoute(
        new Request(url, {
          ...init,
          headers: { Authorization: "Bearer " + jwt(owner) },
        }),
      );
    },
  );
  assert.deepEqual(requestedCursors, [null, "11"]);
  assert.deepEqual(progress, [70, 80]);
  assert.deepEqual(
    snapshot.records.map((record) => Number(record.docEntry)),
    listRows.map((row) => row.DocEntry),
  );
  assert.equal(snapshot.uploads[42].caseId, caseId);
  assert.equal(snapshot.pdfs[42], undefined);
  assert.equal(snapshot.pdfs[45].status, "available");
  assert.equal(snapshot.pdfs[44].status, "missing");
  assert.equal(snapshot.pdfs[1].status, "unavailable");
});

test("a failed or repeated continuation never returns a partial receipt snapshot", async () => {
  for (const repeated of [false, true]) {
    let requests = 0;
    await assert.rejects(
      fetchOpenReceiptSnapshot(
        new AbortController().signal,
        () => {},
        async () => {
          requests++;
          if (requests === 1 || repeated) {
            return Response.json({
              records: [{ docEntry: "80" }],
              uploads: {},
              pdfs: {},
              nextCursor: 80,
            });
          }
          return Response.json(
            { error: "SAP is unavailable." },
            { status: 502 },
          );
        },
      ),
      repeated ? /incomplete receipt list/ : /SAP is unavailable/,
    );
    assert.equal(requests, 2);
  }
});
