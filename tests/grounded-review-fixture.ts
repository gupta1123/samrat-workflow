import type { TestContext } from "node:test";
import {
  COUNTERPARTY_SOURCE_FIELDS,
  REFERENCE_FIELD_DEFINITIONS,
} from "../src/server/processing/semantic-grounding";

type DocumentFixture = {
  docId: string;
  fields: Record<string, unknown>;
  sourceFileName?: string;
  sourcePageNumbers?: number[];
};
type SummaryFixture = {
  counterpartyName: string;
  counterpartySource?: { docId: string; field: string } | null;
  poNumber: string;
  invoiceNumber: string;
  primaryReference: string;
};
type ReviewFixture = {
  documentAudits: Array<{ docId: string; referenceEvidence?: unknown }>;
  corrections?: Array<{
    docId: string;
    fields?: Record<string, unknown> | Array<{ field: string; value: unknown }>;
    unsetFields?: string[];
    quarantineFields?: Array<string | { field: string }>;
  }>;
  pageQuality?: Array<{ documentId: string; pageNumber: number }>;
  packetGroups?: Array<{
    documentIds: string[];
    contextDocumentIds?: string[];
    caseSummary: SummaryFixture;
  }>;
};

// Existing tests focus on audits, mismatch decisions and correction handling.
// Supply their newly required provenance from the explicit request fixture;
// dedicated grounding tests provide malformed evidence without this helper.
export function mockGroundedReview(
  t: TestContext,
  responder: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
) {
  t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const response = await responder(input, init);
      const body = await response.clone().json();
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") return response;
      const review = JSON.parse(content) as ReviewFixture;
      if (!Array.isArray(review.documentAudits)) return response;
      const request = JSON.parse(String(init?.body));
      const user = request.messages.find(
        (message: { role: string }) => message.role === "user",
      );
      const text =
        typeof user.content === "string" ? user.content : user.content[0].text;
      const context = JSON.parse(text.slice(text.indexOf("{"))) as {
        documents: DocumentFixture[];
      };
      const documents = context.documents;
      if (!Array.isArray(documents)) return response;
      const finalDocuments = documents.map((doc) => {
        const fields = { ...doc.fields };
        for (const correction of review.corrections ?? []) {
          if (correction.docId !== doc.docId) continue;
          const changes = Array.isArray(correction.fields)
            ? Object.fromEntries(
                correction.fields.map((change) => [change.field, change.value]),
              )
            : (correction.fields ?? {});
          Object.assign(fields, changes);
          for (const field of correction.unsetFields ?? [])
            delete fields[field];
          for (const entry of correction.quarantineFields ?? [])
            delete fields[typeof entry === "string" ? entry : entry.field];
        }
        return { ...doc, fields };
      });
      for (const audit of review.documentAudits) {
        if (Object.hasOwn(audit, "referenceEvidence")) continue;
        const doc = finalDocuments.find((entry) => entry.docId === audit.docId);
        if (!doc) continue;
        const page =
          review.pageQuality?.find((entry) => entry.documentId === doc.docId) ??
          review.pageQuality?.[0];
        audit.referenceEvidence = REFERENCE_FIELD_DEFINITIONS.flatMap(
          ({ key, label }) => {
            const value = String(doc.fields[key] ?? "").trim();
            return value
              ? [
                  {
                    field: key,
                    value,
                    sourceLabel: label,
                    valueKind: "reference",
                    sourceFileName: doc.sourceFileName,
                    pageNumber:
                      doc.sourcePageNumbers?.[0] ?? page?.pageNumber ?? 1,
                    quote: `${label}: ${value}`,
                  },
                ]
              : [];
          },
        );
      }
      for (const group of review.packetGroups ?? []) {
        const summary = group.caseSummary;
        if (!summary || Object.hasOwn(summary, "counterpartySource")) continue;
        const docs = finalDocuments.filter((doc) =>
          group.documentIds.includes(doc.docId),
        );
        let selected: DocumentFixture | undefined;
        let selectedField: string | undefined;
        for (const doc of docs) {
          if (group.contextDocumentIds?.includes(doc.docId)) continue;
          const field = COUNTERPARTY_SOURCE_FIELDS.find(
            (key) => doc.fields[key] === summary.counterpartyName,
          );
          if (field) {
            selected = doc;
            selectedField = field;
            break;
          }
        }
        summary.counterpartySource =
          selected && selectedField
            ? { docId: selected.docId, field: selectedField }
            : null;
        // Old tests sometimes used decorative placeholder names/references that
        // were absent from their minimal source fixtures. They are not evidence.
        if (!selected) summary.counterpartyName = "";
        for (const [key, fields] of [
          ["poNumber", ["poNumber", "referencePoNumber"]],
          ["invoiceNumber", ["invoiceNumber", "referenceInvoiceNumber"]],
        ] as const) {
          if (
            !docs.some((doc) =>
              fields.some((field) => doc.fields[field] === summary[key]),
            )
          )
            summary[key] = "";
        }
        if (
          ![summary.poNumber, summary.invoiceNumber].includes(
            summary.primaryReference,
          )
        )
          summary.primaryReference = "";
      }
      body.choices[0].message.content = JSON.stringify(review);
      return Response.json(body);
    },
  );
}
