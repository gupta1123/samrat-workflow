import { createHash } from "node:crypto";
import { dbCheck } from "@/server/api/helpers";
import {
  queueIntakeAnalysis,
  type AutomaticIntake,
} from "@/server/automatic-intake";
import type { createSupabaseAdminClient } from "@/server/supabase/admin";
import { grpoPageRows } from "@/lib/sap-grpo-inspector";
import {
  readSapServiceConnection,
  sapCaseEnvironment,
  sapCaseOrigin,
} from "./config";
import { attachGrpoPdfs, importAssetId, storeGrpoPdf } from "./grpo-import";
import { grpoHasOpenQuantity, pdfAttachments, withGrpoPdfs } from "./grpo-pdf";
import { sapFieldConfig } from "./match-data";
import { withSapServiceLayer } from "./service-layer";

type Db = ReturnType<typeof createSupabaseAdminClient>;

const inWindow = (value: unknown, from: string, today: string) => {
  const date = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= from && date <= today;
};

export function automaticGrpoCandidate(
  receipt: Record<string, unknown>,
  attachment: Record<string, unknown> | undefined,
  from: string,
  today: string,
  invoiceField?: string,
) {
  if (!grpoHasOpenQuantity(receipt.DocumentLines)) return null;
  const lines = attachment?.Attachments2_Lines;
  const pdfs = pdfAttachments(receipt.AttachmentEntry, lines);
  const reference = invoiceField ? receipt[invoiceField] : undefined;
  const invoice = [reference, receipt.NumAtCard].find(
    (x): x is string =>
      typeof x === "string" && !!x.trim() && !/^0+$/.test(x.trim()),
  );
  if (
    !pdfs.length ||
    !invoice ||
    typeof receipt.CardCode !== "string" ||
    !receipt.CardCode.trim() ||
    !Number.isSafeInteger(receipt.DocEntry) ||
    !Number.isSafeInteger(receipt.DocNum)
  )
    return null;
  if (
    !inWindow(receipt.DocDate, from, today) &&
    !(
      Array.isArray(lines) &&
      lines.some(
        (line) =>
          String(line?.FileExtension).toLowerCase() === "pdf" &&
          inWindow(line.AttachmentDate, from, today),
      )
    )
  )
    return null;
  return {
    entry: Number(receipt.DocEntry),
    number: Number(receipt.DocNum),
    card: receipt.CardCode,
    invoice: invoice.trim(),
  };
}

async function priorImports(db: Db, company: string, entries: number[]) {
  if (!entries.length) return [];
  const result = await db
    .from("case_review_events")
    .select("case_id,owner_user_id,details")
    .eq("action", "sap_grpo_pdf_imported")
    .contains("details", { company, environment: "live" })
    .in("details->>docEntry", entries.map(String))
    .order("id", { ascending: false });
  dbCheck(result.error);
  return result.data ?? [];
}

async function priorPdfCase(db: Db, hashes: string[]) {
  const found = await db
    .from("packet_case_files")
    .select(
      "case_id,storage_asset_id,content_sha256,packet_cases!inner(created_at,processing_meta)",
    )
    .in("content_sha256", hashes);
  dbCheck(found.error);
  const rows = found.data ?? [];
  const ids = [...new Set(rows.map((f) => f.case_id))].filter((id) =>
    hashes.every((hash) =>
      rows.some((f) => f.case_id === id && f.content_sha256 === hash),
    ),
  );
  return ids
    .map((id) => rows.find((f) => f.case_id === id)!)
    .filter((f) => {
      const joined = Array.isArray(f.packet_cases)
        ? f.packet_cases[0]
        : f.packet_cases;
      return (
        joined &&
        sapCaseEnvironment(
          sapCaseOrigin(joined.created_at, joined.processing_meta),
        ) === "live"
      );
    })
    .map((f) => ({
      caseId: f.case_id,
      assetIds: rows
        .filter((x) => x.case_id === f.case_id)
        .map((x) => x.storage_asset_id),
    }));
}

// Suppress repeated reads of ineligible/temporarily unavailable attachments.
// Durable import history and a deterministic upload ID handle restarts.
const checkAfter = new Map<number, number>();

export async function runAutomaticGrpoIntake(
  db: Db,
  config: AutomaticIntake,
  now: Date,
) {
  const { company } = readSapServiceConnection("live");
  const fields = sapFieldConfig();
  const today = new Date(now.getTime() + 330 * 60_000)
    .toISOString()
    .slice(0, 10);
  for (const [entry, until] of checkAfter)
    if (until <= now.getTime()) checkAfter.delete(entry);

  return withSapServiceLayer(async (client) => {
    let cursor: number | null = null;
    do {
      const limit = 100;
      const page = grpoPageRows(
        await client.listInspectorGrposPage(
          { search: "", supplier: "", status: "open", before: cursor, limit },
          {
            invoice: fields.invoiceRefField ?? "",
            eWayBill: "",
            lorryReceipt: "",
            vehicle: "",
          },
        ),
        limit,
      );
      cursor = page.nextCursor;
      const rows = page.rows.filter(
        (r) =>
          Number(r.AttachmentEntry) > 0 &&
          grpoHasOpenQuantity(r.DocumentLines) &&
          !checkAfter.has(Number(r.DocEntry)),
      );
      if (!rows.length) continue;
      const imports = await priorImports(
        db,
        company,
        rows.map((r) => Number(r.DocEntry)),
      );
      const originByEntry = new Map<number, (typeof imports)[number]>();
      for (const event of imports) {
        if (!originByEntry.has(Number(event.details?.docEntry)))
          originByEntry.set(Number(event.details?.docEntry), event);
      }
      const possible = rows.filter((row) => {
        const event = originByEntry.get(Number(row.DocEntry));
        return (
          !event ||
          (event.details?.automatic === true &&
            event.owner_user_id === config.owner)
        );
      });
      if (!possible.length) continue;
      const attachments = await client.listAttachmentMetadataByEntries([
        ...new Set(possible.map((r) => Number(r.AttachmentEntry))),
      ]);
      for (const row of possible) {
        const entry = Number(row.DocEntry);
        try {
          const item = automaticGrpoCandidate(
            row,
            attachments.get(Number(row.AttachmentEntry)),
            config.fromDate,
            today,
            fields.invoiceRefField,
          );
          if (!item) continue;
          const origin = originByEntry.get(entry);
          if (origin) {
            const c = await db
              .from("packet_cases")
              .select("status,deleted_at")
              .eq("id", origin.case_id)
              .eq("owner_user_id", config.owner)
              .maybeSingle();
            dbCheck(c.error);
            if (c.data?.status !== "draft" || c.data.deleted_at) continue;
          }
          if (
            (await client.findInvoiceByReference(item.card, item.invoice)) ||
            (await client.findDraftByVendorReference(item.card, item.invoice))
          ) {
            checkAfter.set(entry, now.getTime() + 15 * 60_000);
            continue;
          }
          const queued = await withGrpoPdfs(
            entry,
            async (source) => {
              if (
                source.environment !== "live" ||
                source.company !== company ||
                source.docNum !== item.number
              )
                throw new Error(
                  "SAP receipt identity changed during automatic intake.",
                );
              const hashes = source.files.map((file) => {
                if (!file.sha256)
                  throw new Error("SAP attachment digest was unavailable.");
                return file.sha256;
              });
              const manifest = createHash("sha256")
                .update(JSON.stringify(source.files))
                .digest("hex");
              const ids = source.files.map((file) =>
                importAssetId(
                  config.owner,
                  company,
                  entry,
                  "automatic",
                  file.index,
                  manifest,
                ),
              );
              const matching = await priorPdfCase(db, hashes);
              if (origin) {
                if (!matching.some((match) => match.caseId === origin.case_id))
                  return false;
                return Boolean(
                  await queueIntakeAnalysis(
                    db,
                    config.owner,
                    origin.case_id,
                    true,
                  ),
                );
              }
              if (
                matching.length &&
                !matching.some((match) =>
                  ids.every((id) => match.assetIds.includes(id)),
                )
              )
                return false;
              if ((await priorImports(db, company, [entry])).length)
                return false;
              for (const file of source.files) {
                await storeGrpoPdf(db, config.owner, {
                  id: ids[file.index],
                  name: `${file.index + 1}-${file.name.slice(0, -4).slice(0, 230)}.pdf`,
                  bytes: await source.download(file.index),
                });
              }
              const c = await attachGrpoPdfs(db, config.owner, ids, {
                company,
                docEntry: entry,
                docNum: item.number,
                environment: "live",
                automatic: true,
              });
              return (
                c.status === "draft" &&
                Boolean(
                  await queueIntakeAnalysis(db, config.owner, c.caseId, true),
                )
              );
            },
            { requireOpenQuantity: true },
          );
          if (queued)
            console.info("[automatic-intake] Queued SAP receipt", item.number);
          else checkAfter.set(entry, now.getTime() + 5 * 60_000);
          // Download at most one receipt per cycle, even if it was a duplicate.
          return true;
        } catch (error) {
          checkAfter.set(entry, now.getTime() + 15 * 60_000);
          console.warn(
            "[automatic-intake] Receipt needs another check",
            Number(row.DocNum),
            error instanceof Error ? error.message : "Import failed.",
          );
          return true;
        }
      }
    } while (cursor !== null);
    return false;
  }, "live");
}
