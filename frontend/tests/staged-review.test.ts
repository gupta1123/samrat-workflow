import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaseDoc } from "../src/types/pipeline";

process.env.OPENROUTER_API_KEY = "fixture-only-no-network";
const documents: CaseDoc[] = [
  {
    id: "invoice",
    type: "Tax Invoice",
    title: "Invoice",
    pages: 1,
    sourceFileName: "dispatch.pdf",
    sourcePageNumbers: [1],
    fields: {
      vendorName: "Aster Metals",
      buyerName: "Foundry Purchaser",
      referencePoNumber: "ORDER-27",
    },
    md: "Supplier Aster Metals. Buyer Foundry Purchaser. PO ORDER-27. Invoice number:",
  },
  {
    id: "eway",
    type: "E-Way Bill",
    title: "Transport",
    pages: 1,
    sourceFileName: "dispatch.pdf",
    sourcePageNumbers: [2],
    fields: {
      eWayBillNumber: "271948620583",
      referenceInvoiceNumber: "TAX INVOICE",
    },
    md: "Document Details: TAX INVOICE. E-Way Bill No: 271948620583",
  },
];
const pages = documents.map((_, index) => ({
  sourceFileName: "dispatch.pdf",
  pageNumber: index + 1,
  image: `data:image/png;base64,fixture${index}`,
}));

async function compact(document: CaseDoc) {
  const { sourceAuditContext } =
    await import("../src/server/processing/staged-review-contract");
  const context = sourceAuditContext(
    document,
    pages.filter((page) =>
      document.sourcePageNumbers!.includes(page.pageNumber),
    ),
  );
  return {
    sourceVerdict: "verified",
    fieldChecks: Object.fromEntries(
      context.fieldChecksInOrder.map((key) => [key, "supported"]),
    ),
    lineItemChecks: Object.fromEntries(
      context.lineItemChecksInOrder.map((key) => [key, "supported"]),
    ),
    references: Object.fromEntries(
      context.referencesToReview.map((field) => [
        field,
        {
          value:
            field === "referenceInvoiceNumber"
              ? null
              : String(document.fields[field]),
          sourceLabel:
            field === "referenceInvoiceNumber"
              ? "Document Details"
              : field === "referencePoNumber"
                ? "PO"
                : "E-Way Bill No",
          valueKind:
            field === "referenceInvoiceNumber" ? "document_type" : "reference",
          pageNumber: "p1",
          quote:
            field === "referenceInvoiceNumber"
              ? "Document Details: TAX INVOICE"
              : `${field === "referencePoNumber" ? "PO" : "E-Way Bill No"}: ${document.fields[field]}`,
        },
      ]),
    ),
    newReferences: [] as {
      field: string;
      value: string | null;
      sourceLabel: string;
      valueKind: string;
      pageNumber: string;
      quote: string;
    }[],
    fieldChanges: [] as {
      field: string;
      value: string;
      evidenceKind?: "printed" | "visual_observation";
      pageNumber: string;
      quote: string;
    }[],
    removalEvidence: null,
    structureChange: null,
    reviewIssues: [],
    pageQuality: document.sourcePageNumbers!.map((_, index) => ({
      pageNumber: `p${index + 1}`,
      issues: [],
      approvalSafe: true,
      confidence: "high",
      reason: "The supplied page is legible.",
    })),
    reason: "Own-source values verified.",
  };
}
function packet() {
  return {
    packetGroups: [
      {
        label: "Aster Metals / ORDER-27",
        documentIds: ["d1", "d2"],
        relationship: "standard",
        primaryDocumentIds: [],
        contextDocumentIds: [],
        rationale: "Same purchase packet.",
        caseSummary: {
          counterpartySource: { docId: "d1", field: "vendorName" },
          poNumber: "ORDER-27",
          invoiceNumber: "",
          primaryReference: "ORDER-27",
          packetCategory: "Procurement packet",
        },
      },
    ],
    termsChecklist: [],
    sourceRecheckRequests: [] as { docId: string; reason: string }[],
    packetIssues: [],
    notes: [],
  };
}
function memoryStore() {
  const values = new Map<string, string>();
  return {
    values,
    read: async (key: string) => values.get(key) ?? null,
    write: async (key: string, raw: string) => {
      values.set(key, raw);
    },
  };
}
function response(payload: unknown, finish_reason = "stop") {
  return Response.json({
    choices: [{ finish_reason, message: { content: JSON.stringify(payload) } }],
  });
}

test("compact own-source ledger removes a category without inventing a blank invoice number", async () => {
  const { parseCompactSourceAudit } =
    await import("../src/server/processing/staged-review-contract");
  const result = parseCompactSourceAudit(
    JSON.stringify(await compact(documents[1])),
    documents[1],
    [pages[1]],
  );
  assert.equal(result.document.fields.referenceInvoiceNumber, undefined);
  assert.equal(result.document.fields.eWayBillNumber, "271948620583");
  assert.equal(result.audit.status, "corrected");
  assert.equal(result.reviewIssues.length, 0);
  assert.equal(
    parseCompactSourceAudit(
      JSON.stringify(await compact(documents[0])),
      documents[0],
      [pages[0]],
    ).document.fields.invoiceNumber,
    undefined,
  );
});

test("source tasks reject omitted checks, foreign pointers, foreign pages and empty proof", async () => {
  const { parseCompactSourceAudit } =
    await import("../src/server/processing/staged-review-contract");
  const raw = await compact(documents[0]);
  const run = (payload: unknown) =>
    parseCompactSourceAudit(JSON.stringify(payload), documents[0], [pages[0]]);
  assert.throws(() => run({ ...raw, fieldChecks: [] }), /exactly one verdict/);
  assert.throws(
    () =>
      run({
        ...raw,
        pageQuality: [{ ...raw.pageQuality[0], sourceFileName: "foreign.pdf" }],
      }),
    /external source pointers/,
  );
  assert.throws(
    () =>
      run({
        ...raw,
        references: {
          referencePoNumber: {
            ...raw.references.referencePoNumber,
            pageNumber: "p2",
          },
        },
      }),
    /page|source|evidence|proof/i,
  );
  assert.throws(
    () =>
      run({
        ...raw,
        references: {
          referencePoNumber: {
            ...raw.references.referencePoNumber,
            quote: "PO:",
          },
        },
      }),
    /quote|evidence|printed|proof/i,
  );
  assert.throws(() => run({ ...raw, unknown: [] }), /task contract/);
});

test("unsafe page remains a blocking source warning, never approval-safe", async () => {
  const { parseCompactSourceAudit } =
    await import("../src/server/processing/staged-review-contract");
  const raw = await compact(documents[0]);
  const warning = {
    ...raw.pageQuality[0],
    issues: ["faint"],
    approvalSafe: false,
    confidence: "low",
  };
  const result = parseCompactSourceAudit(
    JSON.stringify({
      ...raw,
      sourceVerdict: "needs_review",
      pageQuality: [warning],
    }),
    documents[0],
    [pages[0]],
  );
  assert.equal(result.audit.status, "needs_review");
  assert.equal(result.pageQuality[0].approvalSafe, false);
  assert.throws(
    () =>
      parseCompactSourceAudit(
        JSON.stringify({
          ...raw,
          pageQuality: [{ ...warning, approvalSafe: true }],
        }),
        documents[0],
        [pages[0]],
      ),
    /approval-safe/,
  );
});

test("one paired observation adds a missed buyer name and derives its correction audit", async () => {
  const { parseCompactSourceAudit, buildSourceAuditSchema } =
    await import("../src/server/processing/staged-review-contract");
  const document: CaseDoc = {
    ...documents[0],
    type: "Weighment Slip",
    fields: { vendorName: "Aster Metals" },
  };
  const raw = await compact(document);
  raw.fieldChanges.push({
    field: "buyerName",
    value: "Foundry Purchaser",
    pageNumber: "p1",
    quote: "Buyer Foundry Purchaser",
  });
  const result = parseCompactSourceAudit(JSON.stringify(raw), document, [
    pages[0],
  ]);
  assert.equal(result.document.fields.buyerName, "Foundry Purchaser");
  assert.equal(result.audit.status, "corrected");
  assert.deepEqual(result.audit.visibleOmittedFields, [
    { field: "buyerName", value: "Foundry Purchaser" },
  ]);
  assert.equal(
    result.audit.fieldEvidence?.[0].evidence.quote,
    "Buyer Foundry Purchaser",
  );
  const schema = buildSourceAuditSchema(document, [pages[0]]);
  assert.equal(Object.hasOwn(schema.properties, "visibleOmittedFields"), false);
  assert.equal(Object.hasOwn(schema.properties, "correction"), false);
  const { parseValidatedPacketReconciliation } =
    await import("../src/server/processing/pipeline");
  assert.throws(
    () =>
      parseValidatedPacketReconciliation({
        raw: "{}",
        documents: [
          {
            ...result.document,
            fields: {
              ...result.document.fields,
              buyerName: "Changed after review",
            },
          },
        ],
        documentAudits: [result.audit],
        candidateMismatches: [],
        sourcePages: [pages[0]],
      }),
    /paired-field:buyerName/,
  );
});

test("paired changes reject blank, normalized, duplicate, foreign-page and conflicting proposals", async () => {
  const { parseCompactSourceAudit } =
    await import("../src/server/processing/staged-review-contract");
  const raw = await compact(documents[0]);
  const change = {
    field: "buyerName",
    value: "New Purchaser",
    pageNumber: "p1",
    quote: "Buyer New Purchaser",
  };
  const run = (changes: unknown[], extra = {}) =>
    parseCompactSourceAudit(
      JSON.stringify({ ...raw, fieldChanges: changes, ...extra }),
      documents[0],
      [pages[0]],
    );
  assert.throws(() => run([{ ...change, value: "" }]), /printed field change/);
  assert.throws(
    () => run([{ ...change, value: null }]),
    /printed field change/,
  );
  assert.throws(
    () => run([{ ...change, quote: "Buyer: NEW PURCHASER" }]),
    /buyerName.*literally/,
  );
  assert.throws(
    () => run([{ ...change, pageNumber: "p2" }]),
    /own-page pointer/,
  );
  assert.throws(() => run([change, change]), /duplicate/);
  assert.throws(
    () => run([{ ...change, field: "invoiceNumber" }]),
    /printed field change/,
  );
  assert.throws(
    () =>
      run([change], {
        fieldChecks: { vendorName: "supported", buyerName: "unsupported" },
      }),
    /both unsupported/,
  );
});

test("unsupported votes derive removals without a duplicate correction table", async () => {
  const { parseCompactSourceAudit } =
    await import("../src/server/processing/staged-review-contract");
  const document: CaseDoc = {
    ...documents[0],
    lineItems: [{ description: "Steel", itemCode: "Steel" }],
  };
  const raw = await compact(document);
  const payload = {
    ...raw,
    fieldChecks: { vendorName: "supported", buyerName: "unsupported" },
    lineItemChecks: { description: "supported", itemCode: "unsupported" },
    removalEvidence: { pageNumber: "p1", quote: "Supplier Aster Metals" },
  };
  const result = parseCompactSourceAudit(JSON.stringify(payload), document, [
    pages[0],
  ]);
  assert.equal(result.document.fields.buyerName, undefined);
  assert.equal(result.document.lineItems?.[0].itemCode, undefined);
  assert.equal(result.document.lineItems?.[0].description, "Steel");
  assert.equal(result.audit.status, "corrected");
  assert.throws(
    () =>
      parseCompactSourceAudit(
        JSON.stringify({ ...payload, removalEvidence: null }),
        document,
        [pages[0]],
      ),
    /require removalEvidence/,
  );
});

test("a proved no-op is verified, not an unsupported missing-field finding", async () => {
  const { parseCompactSourceAudit } =
    await import("../src/server/processing/staged-review-contract");
  const raw = await compact(documents[0]);
  raw.fieldChanges.push({
    field: "buyerName",
    value: "Foundry Purchaser",
    pageNumber: "p1",
    quote: "Buyer Foundry Purchaser",
  });
  const result = parseCompactSourceAudit(JSON.stringify(raw), documents[0], [
    pages[0],
  ]);
  assert.equal(result.audit.status, "verified");
  assert.deepEqual(result.audit.visibleOmittedFields, []);
});

test("new references are paired once and cannot repeat original or discovered keys", async () => {
  const { parseCompactSourceAudit } =
    await import("../src/server/processing/staged-review-contract");
  const raw = await compact(documents[0]);
  const found = {
    field: "invoiceNumber",
    value: "INV-28",
    sourceLabel: "Invoice Number",
    valueKind: "reference",
    pageNumber: "p1",
    quote: "Invoice Number INV-28",
  };
  const run = (newReferences: unknown[]) =>
    parseCompactSourceAudit(
      JSON.stringify({ ...raw, newReferences }),
      documents[0],
      [pages[0]],
    );
  assert.equal(run([found]).document.fields.invoiceNumber, "INV-28");
  assert.throws(() => run([found, found]), /distinct/);
  assert.throws(
    () => run([{ ...found, field: "referencePoNumber" }]),
    /distinct/,
  );
});

test("owned page pointers bind an isolated source to original page six without numeric guessing", async () => {
  const { parseCompactSourceAudit } =
    await import("../src/server/processing/staged-review-contract");
  const document: CaseDoc = { ...documents[0], sourcePageNumbers: [6] };
  const source = { ...pages[0], pageNumber: 6 };
  const raw = await compact(documents[0]);
  const result = parseCompactSourceAudit(JSON.stringify(raw), document, [
    source,
  ]);
  assert.equal(result.audit.referenceEvidence[0].pageNumber, 6);
  assert.equal(result.pageQuality[0].pageNumber, 6);
  assert.throws(
    () =>
      parseCompactSourceAudit(
        JSON.stringify({
          ...raw,
          pageQuality: [{ ...raw.pageQuality[0], pageNumber: 6 }],
        }),
        document,
        [source],
      ),
    /own-page pointer/,
  );
});

test("visual evidence may correct declared visual observations but never printed quantities", async () => {
  const { parseCompactSourceAudit } =
    await import("../src/server/processing/staged-review-contract");
  const document: CaseDoc = {
    ...documents[0],
    fields: { ...documents[0].fields, hasAuthorizedSignature: "No" },
  };
  const raw = await compact(document);
  const visual = {
    field: "hasAuthorizedSignature",
    value: "Yes",
    evidenceKind: "visual_observation",
    pageNumber: "p1",
    quote: "Blue handwritten signature visible in the authorized-signature box",
  };
  const result = parseCompactSourceAudit(
    JSON.stringify({ ...raw, fieldChanges: [visual] }),
    document,
    [pages[0]],
  );
  assert.equal(result.document.fields.hasAuthorizedSignature, "Yes");
  assert.equal(
    result.audit.fieldEvidence?.[0].evidenceKind,
    "visual_observation",
  );
  assert.deepEqual(result.audit.visibleOmittedFields, []);
  assert.throws(
    () =>
      parseCompactSourceAudit(
        JSON.stringify({
          ...raw,
          fieldChanges: [{ ...visual, field: "itemQuantity", value: "12 MT" }],
        }),
        document,
        [pages[0]],
      ),
    /requires printed evidence/,
  );
});

test("named source decisions are order-independent and accepted row pages are request-owned", async () => {
  const { parseCompactSourceAudit } =
    await import("../src/server/processing/staged-review-contract");
  const document: CaseDoc = {
    ...documents[0],
    sourcePageNumbers: [6],
    lineItems: [{ description: "Steel", quantity: "12", sourcePage: 1 }],
  };
  const raw = await compact(document);
  const source = { ...pages[0], pageNumber: 6 };
  const result = parseCompactSourceAudit(
    JSON.stringify({
      ...raw,
      fieldChecks: { buyerName: "supported", vendorName: "supported" },
    }),
    document,
    [source],
  );
  assert.equal(result.document.lineItems?.[0].sourcePage, 6);
  assert.throws(
    () =>
      parseCompactSourceAudit(
        JSON.stringify({ ...raw, fieldChecks: { vendorName: "supported" } }),
        document,
        [source],
      ),
    /Required.*buyerName/,
  );
});

test("pointer aliases preserve literal field values and reject unknown document pointers", async () => {
  const { packetPointerAliases } =
    await import("../src/server/processing/staged-review");
  const aliases = packetPointerAliases(documents);
  const encoded = aliases.encode({
    docId: "invoice",
    sourceFileName: "dispatch.pdf",
    fields: { invoiceNumber: "d1" },
    quote: "d1",
  });
  assert.deepEqual(aliases.decode(encoded), {
    docId: "invoice",
    sourceFileName: "dispatch.pdf",
    fields: { invoiceNumber: "d1" },
    quote: "d1",
  });
  assert.throws(
    () => aliases.decode({ docId: "unknown" }),
    /Unknown review source pointer/,
  );
});

test("bounded review concurrency preserves order and settles in-flight work after a failure", async () => {
  const { mapReviewTasks } =
    await import("../src/server/processing/staged-review");
  let active = 0;
  let max = 0;
  assert.deepEqual(
    await mapReviewTasks([1, 2, 3, 4], 2, async (value) => {
      active++;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return value * 2;
    }),
    [2, 4, 6, 8],
  );
  assert.equal(max, 2);
  const finished: number[] = [];
  await assert.rejects(
    () =>
      mapReviewTasks([1, 2, 3], 2, async (value) => {
        if (value === 1) throw new Error("bad stage");
        await new Promise((resolve) => setTimeout(resolve, 5));
        finished.push(value);
      }),
    /bad stage/,
  );
  assert.deepEqual(finished, [2]);
  await assert.rejects(
    () => mapReviewTasks([], 0, async (value) => value),
    /positive integer/,
  );
});

test("checkpoint reuse always revalidates; invalid responses and failed stages are never cached", async () => {
  const { cachedReviewStage } =
    await import("../src/server/processing/review-checkpoints");
  const store = memoryStore();
  let runs = 0;
  const validate = (raw: string) => {
    const value = JSON.parse(raw);
    if (value !== "verified") throw new Error("bad source");
    return value as string;
  };
  const run = async () => {
    runs++;
    return { raw: '"verified"', result: "verified" };
  };
  const options = { key: "stage", store, validate, run };
  assert.equal((await cachedReviewStage(options)).reused, false);
  assert.equal((await cachedReviewStage(options)).reused, true);
  store.values.set("stage", '"invalid"');
  assert.equal((await cachedReviewStage(options)).reused, false);
  assert.equal(runs, 2);
  await assert.rejects(
    () =>
      cachedReviewStage({
        ...options,
        key: "failed",
        run: async () => {
          throw new Error("truncated");
        },
      }),
    /truncated/,
  );
  assert.equal(store.values.has("failed"), false);
});

test("checkpoint digests bind original content, fields, settings and contract, independent of object key order", async () => {
  const { reviewCheckpointKey } =
    await import("../src/server/processing/review-checkpoints");
  const input = {
    image: "original",
    field: "actual",
    model: "Pro",
    reasoning: "2048",
  };
  const key = reviewCheckpointKey("source", input);
  assert.equal(
    key,
    reviewCheckpointKey("source", {
      reasoning: "2048",
      model: "Pro",
      field: "actual",
      image: "original",
    }),
  );
  for (const field of Object.keys(input))
    assert.notEqual(
      key,
      reviewCheckpointKey("source", { ...input, [field]: "changed" }),
    );
  assert.notEqual(key, reviewCheckpointKey("packet", input));
});

test("full staged review resumes verified sources after a truncated packet response and still blocks blank-invoice approval", async (t) => {
  const { reviewExtractedDocumentsInStages } =
    await import("../src/server/processing/staged-review");
  const { buildInvoiceNumberRequiredIssues } =
    await import("../src/lib/invoice-approval");
  const sourcePayloads = await Promise.all(documents.map(compact));
  const store = memoryStore();
  let failPacket = true;
  let sourceCalls = 0;
  let packetCalls = 0;
  const stages: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const name = body.response_format.json_schema.name;
      if (name === "source_document_review") {
        sourceCalls++;
        assert.equal(body.max_tokens, 8192);
        const context = JSON.parse(body.messages[1].content[0].text);
        return response(sourcePayloads[context.sourcePageNumbers[0] - 1]);
      }
      if (name === "packet_reconciliation") {
        packetCalls++;
        assert.equal(body.max_tokens, 8192);
        return response(packet(), failPacket ? "length" : "stop");
      }
      const context = JSON.parse(body.messages[1].content[0].text);
      assert.equal(body.max_tokens, 6144);
      return response({
        mismatchDecisions: context.requestedCandidates.map(
          (candidate: { mismatchId: string }) => ({
            mismatchId: candidate.mismatchId,
            status: "dismissed",
            primary: false,
            outlierDocumentIds: [],
            reason: "No source-proved difference.",
          }),
        ),
      });
    },
  );
  const run = () =>
    reviewExtractedDocumentsInStages(documents, {
      sourcePages: pages,
      checkpoints: store,
      onReviewStage: async (_progress, stage) => {
        stages.push(stage);
      },
    });
  await assert.rejects(run, /could not be verified after two attempts/);
  assert.equal(sourceCalls, 2);
  assert.equal(packetCalls, 2);
  assert.equal(
    [...store.values.keys()].filter((key) => key.startsWith("source/")).length,
    2,
  );
  assert.equal(
    [...store.values.keys()].some((key) => key.startsWith("packet/")),
    false,
  );
  failPacket = false;
  const result = await run();
  assert.equal(sourceCalls, 2);
  assert.equal(packetCalls, 3);
  assert.equal(result.review.resumedCheckpointCount, 2);
  assert.equal(result.documents[1].fields.referenceInvoiceNumber, undefined);
  assert.equal(
    result.authoritativeReview.verificationGroups[0].caseSummary
      .counterpartyName,
    "Aster Metals",
  );
  const mandatory = buildInvoiceNumberRequiredIssues({
    invoiceNumber: "",
    documents: result.documents.map((document) => ({
      id: document.id,
      documentType: document.type,
      invoiceNumber: document.fields.invoiceNumber,
    })),
    verificationGroups: result.authoritativeReview.verificationGroups,
  });
  assert.equal(mandatory.length, 1);
  assert.ok(stages.some((stage) => stage.includes("2 of 2 documents")));
});

test("targeted packet contradiction rechecks only the affected source", async (t) => {
  const { reviewExtractedDocumentsInStages } =
    await import("../src/server/processing/staged-review");
  const payloads = await Promise.all(documents.map(compact));
  const calls = [0, 0];
  let packetCalls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const name = body.response_format.json_schema.name;
      const context = JSON.parse(body.messages[1].content[0].text);
      if (name === "source_document_review") {
        const index = context.sourcePageNumbers[0] - 1;
        calls[index]++;
        return response(payloads[index]);
      }
      if (name === "packet_reconciliation") {
        packetCalls++;
        const payload = packet();
        if (packetCalls === 1)
          payload.sourceRecheckRequests = [
            { docId: "d2", reason: "Recheck the source category's label." },
          ];
        return response(payload);
      }
      return response({
        mismatchDecisions: context.requestedCandidates.map(
          (candidate: { mismatchId: string }) => ({
            mismatchId: candidate.mismatchId,
            status: "dismissed",
            primary: false,
            outlierDocumentIds: [],
            reason: "Equivalent source values.",
          }),
        ),
      });
    },
  );
  await reviewExtractedDocumentsInStages(documents, { sourcePages: pages });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(packetCalls, 2);
});

test("corrupt extraction snapshots cannot bypass source-page provenance", async () => {
  const { parseExtractionCheckpoint } =
    await import("../src/server/processing/extraction-checkpoint");
  const snapshot = {
    documents,
    reviewPages: pages,
    mismatches: [],
    verificationGroups: [],
    summary: {},
    comparisonOptions: {},
    fieldConfiguration: {},
    analysisMode: "standard",
  };
  assert.equal(
    parseExtractionCheckpoint(JSON.stringify(snapshot)).documents.length,
    2,
  );
  assert.throws(
    () =>
      parseExtractionCheckpoint(
        JSON.stringify({ ...snapshot, reviewPages: [pages[0]] }),
      ),
    /missing/,
  );
  assert.throws(
    () =>
      parseExtractionCheckpoint(
        JSON.stringify({ ...snapshot, reviewPages: [pages[0], pages[0]] }),
      ),
    /Duplicate/,
  );
  assert.throws(
    () =>
      parseExtractionCheckpoint(JSON.stringify({ ...snapshot, documents: [] })),
    /structure/,
  );
});

test("26 proposals are partitioned without omissions and each bounded decision set must be complete", async () => {
  const { validateMismatchDecisionBatch } =
    await import("../src/server/processing/pipeline");
  const { buildMismatchReviewBatches } =
    await import("../src/server/processing/staged-review");
  const candidates = Array.from({ length: 26 }, (_, index) => ({
    id: `proposal-${index}`,
    field: "itemQuantity",
    values: [
      { docId: "invoice", value: "25" },
      { docId: "eway", value: "23" },
    ],
    analysis: "Untrusted quantity proposal; original sources decide.",
  }));
  const batches = buildMismatchReviewBatches(candidates, 12);
  assert.deepEqual(
    batches.map((batch) => batch.candidates.length),
    [12, 12, 2],
  );
  assert.deepEqual(
    batches.map((batch) => batch.offset),
    [0, 12, 24],
  );
  assert.deepEqual(
    batches.flatMap((batch) => batch.candidates),
    candidates,
  );
  for (const batch of batches) {
    const decisions = batch.candidates.map((_, index) => ({
      mismatchId: `mismatch-${index + 1}`,
      status: "dismissed",
      primary: false,
      outlierDocumentIds: [],
      reason: "No source-proved difference.",
    }));
    assert.equal(
      validateMismatchDecisionBatch(decisions, batch.candidates).dismissedCount,
      batch.candidates.length,
    );
    assert.throws(
      () => validateMismatchDecisionBatch(decisions.slice(1), batch.candidates),
      /every candidate/,
    );
  }
  assert.throws(
    () => buildMismatchReviewBatches(candidates, 0),
    /positive integer/,
  );
});

test("a run cannot cache a declared result when its raw response fails validation", async () => {
  const { cachedReviewStage } =
    await import("../src/server/processing/review-checkpoints");
  const store = memoryStore();
  await assert.rejects(() =>
    cachedReviewStage({
      key: "invalid-run",
      store,
      validate: (raw) => JSON.parse(raw),
      run: async () => ({ raw: "truncated-json", result: "claimed-verified" }),
    }),
  );
  assert.equal(store.values.size, 0);
});
