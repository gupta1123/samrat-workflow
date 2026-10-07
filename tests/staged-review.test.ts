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
    tableCoverage: {
      status: document.lineItems?.length ? "complete" : "not_present",
      rows: (document.lineItems ?? []).map((item) => ({
        pageNumber: "p1",
        quote: item.description ?? item.itemCode ?? "Visible goods row",
      })),
      evidence: {
        pageNumber: "p1",
        quote: document.md || "Source page inspected",
      },
    },
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

test("an omitted invoice table routes to scoped audit recovery, not a blank successful result", async (t) => {
  const { reviewExtractedDocumentsInStages } =
    await import("../src/server/processing/staged-review");
  const payloads = await Promise.all(documents.map(compact));
  const missingTable = {
    ...payloads[0],
    tableCoverage: {
      status: "complete",
      rows: [{ pageNumber: "p1", quote: "Steel 12 Nos" }],
      evidence: { pageNumber: "p1", quote: "Goods: Steel 12 Nos" },
    },
  };
  let repairCalls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const name = body.response_format.json_schema.name;
      const context = JSON.parse(body.messages[1].content[0].text);
      if (name === "source_document_review")
        return response(
          context.sourcePageNumbers[0] === 1 ? missingTable : payloads[1],
        );
      if (name === "source_audit_repair") {
        repairCalls++;
        assert.match(context.validationDefect, /extraction incomplete/);
        const recovered = {
          ...missingTable,
          structureChange: {
            lineItems: [
              {
                description: "Steel",
                quantity: "12",
                unit: "Nos",
                rawText: "Steel 12 Nos",
              },
            ],
            evidence: { pageNumber: "p1", quote: "Steel 12 Nos" },
          },
        };
        return response(
          Object.fromEntries(
            body.response_format.json_schema.schema.required.map(
              (key: string) => [key, recovered[key as keyof typeof recovered]],
            ),
          ),
        );
      }
      if (name === "packet_reconciliation") return response(packet());
      return response({
        mismatchDecisions: context.requestedCandidates.map(
          (candidate: { mismatchId: string }) => ({
            mismatchId: candidate.mismatchId,
            status: "dismissed",
            primary: false,
            outlierDocumentIds: [],
            reason: "No source-proved conflict",
          }),
        ),
      });
    },
  );
  const result = await reviewExtractedDocumentsInStages(documents, {
    sourcePages: pages,
  });
  assert.equal(repairCalls, 1);
  assert.equal(result.documents[0].lineItems?.[0].quantity, "12");
  assert.equal(result.documents[0].tableCoverage?.status, "complete");
});

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

test("a semantic non-reference verdict removes an echoed candidate value", async () => {
  const { parseCompactSourceAudit } =
    await import("../src/server/processing/staged-review-contract");
  const raw = await compact(documents[1]);
  raw.references.referenceInvoiceNumber = {
    ...raw.references.referenceInvoiceNumber,
    value: "TAX INVOICE",
    valueKind: "document_type",
  };
  const result = parseCompactSourceAudit(JSON.stringify(raw), documents[1], [
    pages[1],
  ]);
  assert.equal(result.document.fields.referenceInvoiceNumber, undefined);
  assert.equal(result.audit.status, "corrected");
});

test("a wrapped newly discovered reference is proved once without conflicting omission validation", async () => {
  const { parseCompactSourceAudit } =
    await import("../src/server/processing/staged-review-contract");
  const raw = await compact(documents[0]);
  raw.newReferences = [
    {
      field: "invoiceNumber",
      value: "INV123456",
      sourceLabel: "Invoice No",
      valueKind: "reference",
      pageNumber: "p1",
      quote: "Invoice No: INV 123456",
    },
  ];
  const result = parseCompactSourceAudit(JSON.stringify(raw), documents[0], [
    pages[0],
  ]);
  assert.equal(result.document.fields.invoiceNumber, "INV123456");
  assert.ok(
    result.audit.referenceEvidence.some(
      ({ field, value }) => field === "invoiceNumber" && value === "INV123456",
    ),
  );
  assert.equal(
    result.audit.visibleOmittedFields.some(
      ({ field }) => field === "invoiceNumber",
    ),
    false,
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
  // A quoted printed correction outweighs a contradictory unsupported vote.
  const contradicted = run([change], {
    fieldChecks: { vendorName: "supported", buyerName: "unsupported" },
  });
  assert.equal(contradicted.document.fields.buyerName, change.value);
});

test("support votes audit the original table while a proved replacement is authoritative", async () => {
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
  const replaced = parseCompactSourceAudit(
    JSON.stringify({
      ...payload,
      lineItemChecks: {
        description: "unsupported",
        itemCode: "supported",
      },
      structureChange: {
        lineItems: [{ description: "Steel", itemCode: "Steel" }],
        evidence: {
          pageNumber: "p1",
          quote: "Steel Steel",
        },
      },
    }),
    document,
    [pages[0]],
  );
  assert.equal(replaced.document.lineItems?.[0].description, "Steel");
  assert.equal(replaced.document.lineItems?.[0].itemCode, "Steel");
  assert.deepEqual(replaced.audit.unsupportedLineItemProperties, []);
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

test("every visual presence field accepts source-image evidence", async () => {
  const { parseCompactSourceAudit } =
    await import("../src/server/processing/staged-review-contract");
  const visualFields = [
    "hasAuthorizedSignature",
    "hasVendorStamp",
    "hasStoreStamp",
    "hasStoreSignature",
    "hasGateStamp",
  ] as const;

  for (const field of visualFields) {
    const document: CaseDoc = {
      ...documents[0],
      fields: { ...documents[0].fields, [field]: "No" },
    };
    const raw = await compact(document);
    const result = parseCompactSourceAudit(
      JSON.stringify({
        ...raw,
        fieldChanges: [
          {
            field,
            value: "Yes",
            evidenceKind: "visual_observation",
            pageNumber: "p1",
            quote: `${field} is visibly present on the source page`,
          },
        ],
      }),
      document,
      [pages[0]],
    );
    assert.equal(result.document.fields[field], "Yes");
    assert.equal(
      result.audit.fieldEvidence?.[0].evidenceKind,
      "visual_observation",
    );
  }
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
  const {
    EXTRACTION_CHECKPOINT_CONTRACT_VERSION,
    STAGED_REVIEW_CONTRACT_VERSION,
  } = await import("../src/server/processing/checkpoint-contract");
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
  assert.notEqual(
    EXTRACTION_CHECKPOINT_CONTRACT_VERSION,
    STAGED_REVIEW_CONTRACT_VERSION,
  );
  assert.notEqual(
    reviewCheckpointKey("extraction", input),
    reviewCheckpointKey("source", input),
  );
});

test("a truncated packet response completes in review and a rerun resumes verified sources", async (t) => {
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
        if (packetCalls === 2)
          assert.equal(body.model, "google/gemini-2.5-flash");
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
  const deferred = await run();
  assert.equal(sourceCalls, 2);
  assert.equal(packetCalls, 2);
  assert.equal(deferred.review.verdict, "needs_review");
  assert.equal(
    deferred.reviewIssues.some(
      (issue) => issue.id === "evidence-review-workflow-packet",
    ),
    true,
  );
  assert.equal(
    deferred.authoritativeReview.verificationGroups[0].label,
    "Packet requires review",
  );
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

test("an incomplete source response fails over to the configured review model without weakening validation", async (t) => {
  const previousConcurrency = process.env.PACKET_SOURCE_REVIEW_CONCURRENCY;
  process.env.PACKET_SOURCE_REVIEW_CONCURRENCY = "1";
  t.after(() => {
    if (previousConcurrency === undefined) {
      delete process.env.PACKET_SOURCE_REVIEW_CONCURRENCY;
    } else {
      process.env.PACKET_SOURCE_REVIEW_CONCURRENCY = previousConcurrency;
    }
  });
  const { reviewExtractedDocumentsInStages } =
    await import("../src/server/processing/staged-review");
  const sourcePayloads = await Promise.all(documents.map(compact));
  const firstSourceModels: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const name = body.response_format.json_schema.name;
      const context = JSON.parse(body.messages[1].content[0].text);
      if (name === "source_document_review") {
        const index = context.sourcePageNumbers[0] - 1;
        if (index === 0) {
          firstSourceModels.push(body.model);
          if (firstSourceModels.length === 1) {
            return response({ incomplete: true }, "length");
          }
        }
        return response(sourcePayloads[index]);
      }
      if (name === "packet_reconciliation") return response(packet());
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
  const result = await reviewExtractedDocumentsInStages(documents, {
    sourcePages: pages,
  });
  assert.deepEqual(firstSourceModels, [
    "google/gemini-3.8-flash",
    "google/gemini-2.5-flash",
  ]);
  assert.equal(result.review.sourceReviewCount, 2);
  assert.equal(result.review.authoritative, true);
});

test("a transient primary review response fails over without replaying the same provider", async (t) => {
  const previousConcurrency = process.env.PACKET_SOURCE_REVIEW_CONCURRENCY;
  process.env.PACKET_SOURCE_REVIEW_CONCURRENCY = "1";
  t.after(() => {
    if (previousConcurrency === undefined) {
      delete process.env.PACKET_SOURCE_REVIEW_CONCURRENCY;
    } else {
      process.env.PACKET_SOURCE_REVIEW_CONCURRENCY = previousConcurrency;
    }
  });
  const { reviewExtractedDocumentsInStages } =
    await import("../src/server/processing/staged-review");
  const sourcePayloads = await Promise.all(documents.map(compact));
  const firstSourceModels: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const name = body.response_format.json_schema.name;
      const context = JSON.parse(body.messages[1].content[0].text);
      if (name === "source_document_review") {
        const index = context.sourcePageNumbers[0] - 1;
        if (index === 0) {
          firstSourceModels.push(body.model);
          if (firstSourceModels.length === 1)
            return Response.json(
              { error: { message: "temporary provider limit" } },
              { status: 429 },
            );
        }
        return response(sourcePayloads[index]);
      }
      if (name === "packet_reconciliation") return response(packet());
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
  await reviewExtractedDocumentsInStages(documents, { sourcePages: pages });
  assert.deepEqual(firstSourceModels, [
    "google/gemini-3.8-flash",
    "google/gemini-2.5-flash",
  ]);
});

test("a primary review network failure uses the independent fallback immediately", async (t) => {
  const previousConcurrency = process.env.PACKET_SOURCE_REVIEW_CONCURRENCY;
  process.env.PACKET_SOURCE_REVIEW_CONCURRENCY = "1";
  t.after(() => {
    if (previousConcurrency === undefined) {
      delete process.env.PACKET_SOURCE_REVIEW_CONCURRENCY;
    } else {
      process.env.PACKET_SOURCE_REVIEW_CONCURRENCY = previousConcurrency;
    }
  });
  const { reviewExtractedDocumentsInStages } =
    await import("../src/server/processing/staged-review");
  const sourcePayloads = await Promise.all(documents.map(compact));
  const firstSourceModels: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const name = body.response_format.json_schema.name;
      const context = JSON.parse(body.messages[1].content[0].text);
      if (name === "source_document_review") {
        const index = context.sourcePageNumbers[0] - 1;
        if (index === 0) {
          firstSourceModels.push(body.model);
          if (firstSourceModels.length === 1)
            throw new Error("simulated network reset");
        }
        return response(sourcePayloads[index]);
      }
      if (name === "packet_reconciliation") return response(packet());
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
  await reviewExtractedDocumentsInStages(documents, { sourcePages: pages });
  assert.deepEqual(firstSourceModels, [
    "google/gemini-3.8-flash",
    "google/gemini-2.5-flash",
  ]);
});

test("full staged review verifies all confirmed candidates through the root-cause contract", async (t) => {
  const { reviewExtractedDocumentsInStages } =
    await import("../src/server/processing/staged-review");
  const conflictingDocuments = documents.map((document, index) => ({
    ...structuredClone(document),
    fields: {
      ...document.fields,
      vehicleNumber: index === 0 ? "TRUCK-A" : "TRUCK-B",
    },
    md: `${document.md} Vehicle: ${index === 0 ? "TRUCK-A" : "TRUCK-B"}`,
  }));
  const sourcePayloads = await Promise.all(conflictingDocuments.map(compact));
  let rootCalls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const name = body.response_format.json_schema.name;
      const context = JSON.parse(body.messages[1].content[0].text);
      if (name === "source_document_review") {
        return response(sourcePayloads[context.sourcePageNumbers[0] - 1]);
      }
      if (name === "packet_reconciliation") return response(packet());
      if (name === "packet_mismatch_decisions") {
        return response({
          mismatchDecisions: context.requestedCandidates.map(
            (candidate: { mismatchId: string }) => ({
              mismatchId: candidate.mismatchId,
              status: "confirmed",
              primary: true,
              outlierDocumentIds: [],
              reason: "The original pages contain different values.",
            }),
          ),
        });
      }
      assert.equal(name, "packet_mismatch_root_causes");
      rootCalls++;
      return response({
        rootIssues: context.confirmedCandidates.map(
          (candidate: { mismatchId: string }, index: number) => ({
            issueId: `root-${index + 1}`,
            kind: "field_discrepancy",
            primaryMismatchId: candidate.mismatchId,
            memberMismatchIds: [candidate.mismatchId],
            outlierDocumentIds: [],
            title: "Independent source discrepancy",
            reason:
              "The printed values differ and neither source is proved unrelated.",
          }),
        ),
        dismissedMismatchIds: [],
      });
    },
  );
  const result = await reviewExtractedDocumentsInStages(conflictingDocuments, {
    sourcePages: pages,
  });
  assert.equal(rootCalls, 1);
  assert.ok(result.authoritativeReview.mismatches.length > 0);
  assert.equal(
    result.review.confirmedMismatchCount,
    result.authoritativeReview.mismatches.length,
  );
  assert.ok(
    result.authoritativeReview.mismatches.every((issue) =>
      issue.analysis?.startsWith("Authoritative root-cause review:"),
    ),
  );
});

test("packet-discovered symptoms join confirmed candidates in one final root cause", async (t) => {
  const { reviewExtractedDocumentsInStages } =
    await import("../src/server/processing/staged-review");
  const conflictingDocuments = documents.map((document, index) => ({
    ...structuredClone(document),
    fields: { ...document.fields },
    md: `${document.md} Vehicle: ${index === 0 ? "TRUCK-A" : "TRUCK-B"}. Buyer: ${index === 0 ? "Buyer Alpha" : "Buyer Beta"}.`,
  }));
  const sourcePayloads = await Promise.all(conflictingDocuments.map(compact));
  let rootCandidateFields: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const name = body.response_format.json_schema.name;
      const context = JSON.parse(body.messages[1].content[0].text);
      if (name === "source_document_review") {
        return response(sourcePayloads[context.sourcePageNumbers[0] - 1]);
      }
      if (name === "packet_reconciliation") {
        return response({
          ...packet(),
          packetIssues: [
            {
              field: "vehicleNumber",
              reason:
                "The printed vehicle identities describe different shipments.",
              evidence: [
                {
                  docId: "d1",
                  value: "TRUCK-A",
                  sourceFileName: "f1",
                  pageNumber: 1,
                  quote: "Vehicle: TRUCK-A",
                },
                {
                  docId: "d2",
                  value: "TRUCK-B",
                  sourceFileName: "f1",
                  pageNumber: 2,
                  quote: "Vehicle: TRUCK-B",
                },
              ],
            },
            {
              field: "buyerName",
              reason:
                "The printed buyer identities describe different shipments.",
              evidence: [
                {
                  docId: "d1",
                  value: "Buyer Alpha",
                  sourceFileName: "f1",
                  pageNumber: 1,
                  quote: "Buyer: Buyer Alpha",
                },
                {
                  docId: "d2",
                  value: "Buyer Beta",
                  sourceFileName: "f1",
                  pageNumber: 2,
                  quote: "Buyer: Buyer Beta",
                },
              ],
            },
          ],
        });
      }
      if (name === "packet_mismatch_decisions") {
        return response({
          mismatchDecisions: context.requestedCandidates.map(
            (candidate: { mismatchId: string }) => ({
              mismatchId: candidate.mismatchId,
              status: "dismissed",
              primary: false,
              outlierDocumentIds: [],
              reason: "No additional independent discrepancy is established.",
            }),
          ),
        });
      }
      assert.equal(name, "packet_mismatch_root_causes");
      rootCandidateFields = context.confirmedCandidates.map(
        (candidate: { field: string }) => candidate.field,
      );
      return response({
        rootIssues: [
          {
            issueId: "root-unrelated-source",
            kind: "unrelated_document",
            primaryMismatchId: context.confirmedCandidates[0].mismatchId,
            memberMismatchIds: context.confirmedCandidates.map(
              (candidate: { mismatchId: string }) => candidate.mismatchId,
            ),
            outlierDocumentIds: ["d2"],
            title: "Unrelated source document",
            reason:
              "The second document carries a different vehicle and buyer.",
          },
        ],
        dismissedMismatchIds: [],
      });
    },
  );

  const result = await reviewExtractedDocumentsInStages(conflictingDocuments, {
    sourcePages: pages,
  });
  assert.ok(rootCandidateFields.includes("vehicleNumber"));
  assert.ok(rootCandidateFields.includes("buyerName"));
  assert.equal(result.authoritativeReview.mismatches.length, 1);
  assert.equal(result.reviewIssues.length, 0);
  assert.equal(
    result.authoritativeReview.mismatches[0].field,
    "unrelatedDocument",
  );
  assert.deepEqual(
    new Set(
      result.authoritativeReview.mismatches[0].values.map(
        (entry) => entry.evidenceField,
      ),
    ),
    new Set(["vehicleNumber", "buyerName"]),
  );
});

test("an ungrounded optional packet issue is discarded without erasing the verified packet group", async (t) => {
  const { reviewExtractedDocumentsInStages } =
    await import("../src/server/processing/staged-review");
  const sourcePayloads = await Promise.all(documents.map(compact));
  let packetCalls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const name = body.response_format.json_schema.name;
      const context = JSON.parse(body.messages[1].content[0].text);
      if (name === "source_document_review") {
        return response(sourcePayloads[context.sourcePageNumbers[0] - 1]);
      }
      if (name === "packet_reconciliation") {
        packetCalls++;
        return response({
          ...packet(),
          packetIssues: [
            {
              field: "notAConfiguredField",
              reason: "This optional proposal is outside the field contract.",
              evidence: [
                {
                  docId: "d1",
                  value: "Aster Metals",
                  sourceFileName: "f1",
                  pageNumber: 1,
                  quote: "Supplier Aster Metals",
                },
              ],
            },
          ],
        });
      }
      if (name === "packet_mismatch_decisions") {
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
      }
      throw new Error(`Unexpected review task: ${name}`);
    },
  );

  const result = await reviewExtractedDocumentsInStages(documents, {
    sourcePages: pages,
  });
  assert.equal(packetCalls, 1);
  assert.equal(
    result.authoritativeReview.verificationGroups[0].caseSummary.poNumber,
    "ORDER-27",
  );
  assert.equal(
    result.reviewIssues.some(
      (issue) => issue.id === "evidence-review-workflow-packet",
    ),
    false,
  );
  assert.ok(
    result.review.warnings.some((warning) =>
      warning.includes("without discarding the verified packet grouping"),
    ),
  );
});

test("an invalid reference proof is repaired from the original source page without rerunning extraction", async (t) => {
  const { reviewExtractedDocumentsInStages } =
    await import("../src/server/processing/staged-review");
  const sourcePayloads = await Promise.all(documents.map(compact));
  const invalid = structuredClone(sourcePayloads[0]);
  invalid.references.referencePoNumber.quote = "PO:";
  const sourceCalls = [0, 0];
  let repairCalls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const name = body.response_format.json_schema.name;
      const context = JSON.parse(body.messages[1].content[0].text);
      if (name === "source_document_review") {
        const index = context.sourcePageNumbers[0] - 1;
        sourceCalls[index]++;
        return response(index === 0 ? invalid : sourcePayloads[index]);
      }
      if (name === "source_reference_repair") {
        repairCalls++;
        assert.deepEqual(context.referencesToReview, ["referencePoNumber"]);
        assert.equal(
          context.originalReferenceValues.referencePoNumber,
          "ORDER-27",
        );
        return response({
          references: sourcePayloads[0].references,
          newReferences: sourcePayloads[0].newReferences,
        });
      }
      if (name === "packet_reconciliation") return response(packet());
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
  const result = await reviewExtractedDocumentsInStages(documents, {
    sourcePages: pages,
  });
  assert.deepEqual(sourceCalls, [1, 1]);
  assert.equal(repairCalls, 1);
  assert.equal(result.documents[0].fields.referencePoNumber, "ORDER-27");
  assert.equal(result.review.sourceReviewCount, 2);
});

test("a non-reference correction with normalized evidence is repaired without entering the reference contract", async (t) => {
  const previousConcurrency = process.env.PACKET_SOURCE_REVIEW_CONCURRENCY;
  process.env.PACKET_SOURCE_REVIEW_CONCURRENCY = "1";
  t.after(() => {
    if (previousConcurrency === undefined) {
      delete process.env.PACKET_SOURCE_REVIEW_CONCURRENCY;
    } else {
      process.env.PACKET_SOURCE_REVIEW_CONCURRENCY = previousConcurrency;
    }
  });
  const { reviewExtractedDocumentsInStages } =
    await import("../src/server/processing/staged-review");
  const payloads = await Promise.all(documents.map(compact));
  const invalid = structuredClone(payloads[0]);
  invalid.fieldChanges = [
    {
      field: "igstRate",
      value: "18.00 %",
      evidenceKind: "printed",
      pageNumber: "p1",
      quote: "IGST @ 18%",
    },
  ];
  const models: string[] = [];
  let referenceRepairCalls = 0;
  let fieldRepairCalls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const name = body.response_format.json_schema.name;
      const context = JSON.parse(body.messages[1].content[0].text);
      if (name === "source_reference_repair") referenceRepairCalls++;
      if (name === "source_document_review") {
        const index = context.sourcePageNumbers[0] - 1;
        if (index === 0) models.push(body.model);
        return response(index === 0 ? invalid : payloads[index]);
      }
      if (name === "source_field_changes_repair") {
        fieldRepairCalls++;
        assert.equal(context.proposedFieldChanges[0].field, "igstRate");
        return response({
          fieldChanges: [
            {
              field: "igstRate",
              value: "18%",
              evidenceKind: "printed",
              pageNumber: "p1",
              quote: "IGST @ 18%",
            },
          ],
        });
      }
      if (name === "packet_reconciliation") return response(packet());
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
  const result = await reviewExtractedDocumentsInStages(documents, {
    sourcePages: pages,
  });
  assert.equal(models[0], "google/gemini-3.8-flash");
  assert.deepEqual(models, ["google/gemini-3.8-flash"]);
  assert.equal(referenceRepairCalls, 0);
  assert.equal(fieldRepairCalls, 1);
  assert.equal(result.documents[0].fields.igstRate, "18%");
});

test("an inconsistent source audit is repaired from its own page without fabricating removal evidence", async (t) => {
  const previousConcurrency = process.env.PACKET_SOURCE_REVIEW_CONCURRENCY;
  process.env.PACKET_SOURCE_REVIEW_CONCURRENCY = "1";
  t.after(() => {
    if (previousConcurrency === undefined) {
      delete process.env.PACKET_SOURCE_REVIEW_CONCURRENCY;
    } else {
      process.env.PACKET_SOURCE_REVIEW_CONCURRENCY = previousConcurrency;
    }
  });
  const { reviewExtractedDocumentsInStages } =
    await import("../src/server/processing/staged-review");
  const payloads = await Promise.all(documents.map(compact));
  const invalid = structuredClone(payloads[0]);
  const unsupportedField = Object.keys(invalid.fieldChecks)[0];
  assert.ok(unsupportedField);
  invalid.fieldChecks[unsupportedField] = "unsupported";
  invalid.removalEvidence = null;
  const sourceCalls = [0, 0];
  let auditRepairCalls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const name = body.response_format.json_schema.name;
      const context = JSON.parse(body.messages[1].content[0].text);
      if (name === "source_document_review") {
        const index = context.sourcePageNumbers[0] - 1;
        sourceCalls[index]++;
        return response(index === 0 ? invalid : payloads[index]);
      }
      if (name === "source_audit_repair") {
        auditRepairCalls++;
        assert.equal(
          context.validationDefect.includes("removalEvidence"),
          true,
        );
        const validAudit = payloads[0] as unknown as Record<string, unknown>;
        return response(
          Object.fromEntries(
            [
              "sourceVerdict",
              "fieldChecks",
              "lineItemChecks",
              "tableCoverage",
              "removalEvidence",
              "structureChange",
              "pageQuality",
              "reviewIssues",
              "reason",
            ].map((key) => [key, validAudit[key]]),
          ),
        );
      }
      if (name === "packet_reconciliation") return response(packet());
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
  const result = await reviewExtractedDocumentsInStages(documents, {
    sourcePages: pages,
  });
  assert.deepEqual(sourceCalls, [1, 1]);
  assert.equal(auditRepairCalls, 1);
  assert.equal(
    result.documents[0].fields[unsupportedField as keyof CaseDoc["fields"]],
    documents[0].fields[unsupportedField as keyof CaseDoc["fields"]],
  );
});

test("an unrepairable source contract preserves extraction and completes with review blocked", async (t) => {
  const previousConcurrency = process.env.PACKET_SOURCE_REVIEW_CONCURRENCY;
  process.env.PACKET_SOURCE_REVIEW_CONCURRENCY = "1";
  t.after(() => {
    if (previousConcurrency === undefined) {
      delete process.env.PACKET_SOURCE_REVIEW_CONCURRENCY;
    } else {
      process.env.PACKET_SOURCE_REVIEW_CONCURRENCY = previousConcurrency;
    }
  });
  const { reviewExtractedDocumentsInStages } =
    await import("../src/server/processing/staged-review");
  const payloads = await Promise.all(documents.map(compact));
  const invalid = structuredClone(payloads[0]);
  const unsupportedField = Object.keys(invalid.fieldChecks)[0];
  assert.ok(unsupportedField);
  invalid.fieldChecks[unsupportedField] = "unsupported";
  invalid.removalEvidence = null;
  const invalidAudit = Object.fromEntries(
    [
      "sourceVerdict",
      "fieldChecks",
      "lineItemChecks",
      "tableCoverage",
      "removalEvidence",
      "structureChange",
      "pageQuality",
      "reviewIssues",
      "reason",
    ].map((key) => [key, (invalid as unknown as Record<string, unknown>)[key]]),
  );
  let auditRepairCalls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const name = body.response_format.json_schema.name;
      const context = JSON.parse(body.messages[1].content[0].text);
      if (name === "source_document_review") {
        const index = context.sourcePageNumbers[0] - 1;
        return response(index === 0 ? invalid : payloads[index]);
      }
      if (name === "source_audit_repair") {
        auditRepairCalls++;
        return response(invalidAudit);
      }
      if (name === "packet_reconciliation") return response(packet());
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
  const result = await reviewExtractedDocumentsInStages(documents, {
    sourcePages: pages,
  });
  assert.equal(auditRepairCalls, 2);
  assert.equal(result.review.verdict, "needs_review");
  assert.equal(result.review.documentAudits?.[0].status, "needs_review");
  assert.equal(
    result.documents[0].fields[unsupportedField as keyof CaseDoc["fields"]],
    documents[0].fields[unsupportedField as keyof CaseDoc["fields"]],
  );
  assert.equal(
    result.reviewIssues.some(
      (issue) => issue.field === "extractionVerification",
    ),
    true,
  );
});

test("unrepairable mismatch decisions complete with an approval-blocking workflow issue", async (t) => {
  const { reviewExtractedDocumentsInStages } =
    await import("../src/server/processing/staged-review");
  const payloads = await Promise.all(documents.map(compact));
  let decisionCalls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const name = body.response_format.json_schema.name;
      const context = JSON.parse(body.messages[1].content[0].text);
      if (name === "source_document_review") {
        return response(payloads[context.sourcePageNumbers[0] - 1]);
      }
      if (name === "packet_reconciliation") return response(packet());
      if (name === "packet_mismatch_decisions") {
        decisionCalls++;
        return response({ mismatchDecisions: [] });
      }
      throw new Error(`Unexpected review operation ${name}`);
    },
  );
  const result = await reviewExtractedDocumentsInStages(documents, {
    sourcePages: pages,
  });
  assert.equal(decisionCalls, 2);
  assert.equal(result.review.verdict, "needs_review");
  assert.equal(
    result.reviewIssues.some(
      (issue) => issue.id === "evidence-review-workflow-decisions",
    ),
    true,
  );
  assert.equal(result.authoritativeReview.mismatches.length, 0);
});

test("unrepairable root-cause consolidation retains verified mismatches for review", async (t) => {
  const { reviewExtractedDocumentsInStages } =
    await import("../src/server/processing/staged-review");
  const payloads = await Promise.all(documents.map(compact));
  let rootCalls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const name = body.response_format.json_schema.name;
      const context = JSON.parse(body.messages[1].content[0].text);
      if (name === "source_document_review") {
        return response(payloads[context.sourcePageNumbers[0] - 1]);
      }
      if (name === "packet_reconciliation") return response(packet());
      if (name === "packet_mismatch_decisions") {
        return response({
          mismatchDecisions: context.requestedCandidates.map(
            (candidate: { mismatchId: string }) => ({
              mismatchId: candidate.mismatchId,
              status: "confirmed",
              primary: false,
              outlierDocumentIds: [],
              reason: "The printed source values differ.",
            }),
          ),
        });
      }
      if (name === "packet_mismatch_root_causes") {
        rootCalls++;
        return response({});
      }
      throw new Error(`Unexpected review operation ${name}`);
    },
  );
  const result = await reviewExtractedDocumentsInStages(documents, {
    sourcePages: pages,
  });
  assert.equal(rootCalls, 2);
  assert.equal(result.review.verdict, "needs_review");
  assert.equal(
    result.reviewIssues.some(
      (issue) => issue.id === "evidence-review-workflow-root-causes",
    ),
    true,
  );
  assert.equal(result.authoritativeReview.mismatches.length > 0, true);
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
