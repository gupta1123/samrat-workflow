// Read-only replay of previously downloaded original page images. No database
// writes, case approvals, SAP selections or drafts are performed.
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { CaseDoc, DocType } from "../src/types/pipeline";
import { PDFDocument } from "pdf-lib";

async function main() {
  const auditRoot = process.argv[2];
  if (!auditRoot)
    throw new Error(
      "Usage: tsx scripts/replay-source-extraction-audit.ts AUDIT_FOLDER [OUTPUT_FOLDER]",
    );
  const outputRoot = process.argv[3] || join(auditRoot, "source-review-replay");
  const originalsRoot = process.argv[4];
  const selectedFolders = new Set(
    (process.argv[5] || "").split(",").filter(Boolean),
  );
  const selectedPages = new Set(
    (process.argv[6] || "").split(",").filter(Boolean),
  );
  const config = JSON.parse(
    execFileSync("heroku", ["config", "--json", "-a", "samrat-workflow"], {
      encoding: "utf8",
    }),
  );
  for (const [key, value] of Object.entries(config))
    if (
      (key.startsWith("OPENROUTER_") || key.startsWith("PACKET_")) &&
      typeof value === "string"
    )
      process.env[key] = value;
  const { reviewOneSource, mapReviewTasks } =
    await import("../src/server/processing/staged-review");
  const { readStoredLineItems, stripStoredLineItems } =
    await import("../src/server/line-items");
  const { readStoredLogisticsRows } =
    await import("../src/lib/extracted-source-rows");
  const { renderUploadedFileForReview } =
    await import("../src/server/processing/pipeline");
  mkdirSync(outputRoot, { recursive: true });
  const requested: Array<[string, DocType, number]> = [
    ["11", "Tax Invoice", 1],
    ["11", "Material Test Certificate", 3],
    ["11", "Lorry Receipt", 4],
    ["10", "Tax Invoice", 1],
    ["10", "E-Way Bill", 3],
    ["10", "Material Test Certificate", 2],
    ["01", "Tax Invoice", 1],
    ["03", "E-Way Bill", 4],
    ["07", "Weighment Slip", 8],
    ["13", "Tax Invoice", 2],
  ];
  const results = await mapReviewTasks(
    requested.filter(
      ([folder, , page]) =>
        (!selectedFolders.size || selectedFolders.has(folder)) &&
        (!selectedPages.size || selectedPages.has(String(page))),
    ),
    2,
    async ([folder, type, page]) => {
      const saved = JSON.parse(
        readFileSync(join(auditRoot, folder, "saved.json"), "utf8"),
      );
      const entry = saved.documents.find(
        (doc: { document_type: string }) => doc.document_type === type,
      );
      if (!entry) throw new Error(`No ${type} in ${folder}`);
      const document: CaseDoc = {
        id: entry.client_document_id,
        type,
        title: entry.title || type,
        pages: 1,
        sourceFileName: entry.source_file_name,
        sourcePageNumbers: [page],
        sourceHint: entry.source_hint,
        fields: stripStoredLineItems(entry.extracted_fields),
        lineItems: readStoredLineItems(entry.extracted_fields),
        logisticsRows: readStoredLogisticsRows(entry.extracted_fields),
        md: entry.markdown || "",
      };
      let image = `data:image/png;base64,${readFileSync(join(auditRoot, folder, `page-${page}.png`)).toString("base64")}`;
      if (originalsRoot) {
        const directory = readdirSync(originalsRoot).find((name) =>
          name.startsWith(`${folder} - `),
        );
        if (!directory) throw new Error("Original source folder is missing.");
        const original = await PDFDocument.load(
          readFileSync(join(originalsRoot, directory, entry.source_file_name)),
        );
        const single = await PDFDocument.create();
        const [selected] = await single.copyPages(original, [page - 1]);
        single.addPage(selected);
        [image] = await renderUploadedFileForReview({
          bytes: await single.save(),
          fileName: entry.source_file_name,
          mimeType: "application/pdf",
        });
      }
      const pages = [
        { sourceFileName: document.sourceFileName!, pageNumber: page, image },
      ];
      const started = Date.now();
      try {
        const result = await reviewOneSource({ document, pages });
        const row = {
          folder,
          type,
          page,
          elapsedMs: Date.now() - started,
          attempts: result.attempts,
          result: result.result,
        };
        writeFileSync(
          join(outputRoot, `${folder}-${page}.json`),
          JSON.stringify(row, null, 2),
        );
        console.log(
          JSON.stringify({
            folder,
            type,
            page,
            elapsedMs: row.elapsedMs,
            fields: result.result.document.fields,
            lineItems: result.result.document.lineItems,
            logisticsRows: result.result.document.logisticsRows,
            sourceStatus: result.result.audit.status,
            warnings: result.result.summary.warnings,
            reviewIssues: result.result.reviewIssues,
          }),
        );
        return row;
      } catch (error) {
        const row = {
          folder,
          type,
          page,
          elapsedMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        };
        console.log(JSON.stringify(row));
        return row;
      }
    },
  );
  writeFileSync(
    join(outputRoot, "results.json"),
    JSON.stringify(results, null, 2),
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
