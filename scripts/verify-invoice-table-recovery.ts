// Read-only production-source regression. Runs local review against original
// pixels; never uploads, analyzes, updates, approves or posts the saved case.
// Usage: npx tsx scripts/verify-invoice-table-recovery.ts CASE_ID PDF_PATH
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { CaseDoc } from "../src/types/pipeline";
import {
  readStoredLineItems,
  stripStoredLineItems,
  serializeFieldsWithLineItems,
} from "../src/server/line-items";
import { buildMatchInvoice } from "../src/server/sap/match-mapping";

async function main() {
  const [caseId, pdfPath] = process.argv.slice(2);
  assert.ok(caseId && pdfPath, "Supply case ID and its original PDF path");
  const config = JSON.parse(
    execFileSync("heroku", ["config", "--json", "--app", "samrat-workflow"], {
      encoding: "utf8",
    }),
  );
  Object.assign(process.env, config);
  const db = createClient(
    config.SUPABASE_INTERNAL_URL ||
      config.SUPABASE_URL ||
      config.NEXT_PUBLIC_SUPABASE_URL,
    config.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await db
    .from("packet_documents")
    .select(
      "client_document_id,document_type,title,extracted_fields,source_file_name,markdown",
    )
    .eq("case_id", caseId);
  if (error) throw error;
  const row = data?.find(
    (doc) =>
      doc.document_type === "Tax Invoice" || doc.document_type === "Invoice",
  );
  assert.ok(row, "No invoice in this case");
  const sourceFileName = String(row.source_file_name);
  const document: CaseDoc = {
    id: row.client_document_id,
    type: row.document_type as CaseDoc["type"],
    title: row.title,
    fields: stripStoredLineItems(row.extracted_fields),
    lineItems: readStoredLineItems(row.extracted_fields),
    md: row.markdown ?? "",
    pages: 1,
    sourceFileName,
    sourcePageNumbers: [1],
  };
  // This reproduction is deliberately scoped to the supplied invoice page 1.
  // Review supplies every recovered value from those pixels, not this script.
  const directory = mkdtempSync(join(tmpdir(), "samrat-table-recovery-"));
  const prefix = join(directory, "invoice");
  execFileSync("pdftoppm", [
    "-f",
    "1",
    "-l",
    "1",
    "-singlefile",
    "-r",
    "140",
    "-png",
    pdfPath,
    prefix,
  ]);
  const image = `data:image/png;base64,${readFileSync(`${prefix}.png`).toString("base64")}`;
  const { reviewExtractedDocumentsInStages } =
    await import("../src/server/processing/staged-review");
  console.log("Saved invoice rows:", document.lineItems?.length ?? 0);
  const result = await reviewExtractedDocumentsInStages([document], {
    sourcePages: [{ sourceFileName, pageNumber: 1, image }],
  });
  const recovered = result.documents[0];
  assert.equal(recovered.tableCoverage?.status, "complete");
  assert.ok(
    recovered.lineItems?.length,
    "Source recovery did not obtain any item rows",
  );
  const invoice = buildMatchInvoice({
    caseInvoiceNumber: recovered.fields.invoiceNumber,
    casePoNumber: recovered.fields.poNumber,
    documents: [
      {
        document_type: recovered.type,
        extracted_fields: serializeFieldsWithLineItems(recovered),
      },
    ],
  });
  assert.equal(invoice?.extractionIssue, undefined);
  assert.ok(invoice?.lines.length);
  console.log(
    JSON.stringify(
      {
        rows: recovered.lineItems,
        coverage: recovered.tableCoverage,
        attempts: result.review.attemptCount,
        imagePath: `${prefix}.png`,
        productionWrites: 0,
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
