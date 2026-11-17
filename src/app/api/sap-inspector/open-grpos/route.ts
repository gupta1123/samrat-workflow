import {
  readSapEnvironment,
  readSapServiceConnection,
} from "@/server/sap/config";
import { ApiError, withUser } from "@/server/api/helpers";
import { productionAutomaticIntake } from "@/server/automatic-intake";
import { withSapServiceLayer } from "@/server/sap/service-layer";
import { sapFieldConfig } from "@/server/sap/match-data";
import { normalizeSapInspectorRecords } from "@/lib/sap-inspector";
import {
  grpoPageRows,
  parseGrpoInspectorQuery,
} from "@/lib/sap-grpo-inspector";
import { grpoPdfAvailability } from "@/server/sap/grpo-pdf-availability";
import {
  grpoExistingApDocuments,
  grpoVendorInvoiceReference,
} from "@/server/sap/grpo-drafts";
import {
  automaticGrpoCandidate,
  readAutomaticGrpoImportHistory,
} from "@/server/sap/automatic-grpo";
import { grpoUploadStates } from "@/server/sap/grpo-import";
import type { SapInspectorRecord } from "@/lib/sap-inspector";
import type { GrpoAutomaticStatus, GrpoUploadState } from "@/lib/grpo-import";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) {
  return withUser(request, async (db, user) => {
    const params = new URL(request.url).searchParams;
    if (!params.has("limit")) params.set("limit", "10");
    let query;
    try {
      query = parseGrpoInspectorQuery(params);
    } catch {
      throw new ApiError("Invalid GRPO search.");
    }
    const tab = params.get("uploaded") ?? "no";
    if (tab !== "yes" && tab !== "no" && tab !== "all")
      throw new ApiError("Invalid upload tab.");
    const config = sapFieldConfig();
    const environment = readSapEnvironment();
    const automatic = productionAutomaticIntake(environment);
    const { company } = readSapServiceConnection(environment);
    return withSapServiceLayer(async (client) => {
      const records: SapInspectorRecord[] = [];
      const uploads: Record<string, GrpoUploadState> = {};
      let allPageUploads: Promise<Record<string, GrpoUploadState>> | undefined;
      let cursor = query.before;
      let nextCursor: number | null = null;
      // Filter before returning a page, retaining a cursor even for sparse tabs.
      for (let scan = 0; scan < 5 && records.length < query.limit; scan++) {
        const page = grpoPageRows(
          await client.listInspectorGrposPage(
            { ...query, status: "open", before: cursor },
            {
              invoice: config.invoiceRefField ?? "",
              eWayBill: config.eWayBillField ?? "",
              lorryReceipt: config.lorryReceiptField ?? "",
              vehicle: config.vehicleField ?? "",
            },
          ),
          query.limit,
        );
        const basic = normalizeSapInspectorRecords("grpo", page.rows);
        if (tab === "all") {
          records.push(...basic);
          nextCursor = page.nextCursor;
          allPageUploads = grpoUploadStates(db, user, company, basic);
          break;
        }
        const states = await grpoUploadStates(db, user, company, basic);
        let consumed = 0;
        for (const record of basic) {
          consumed++;
          const saved = states[String(record.docEntry)];
          const upload = saved?.deleted ? undefined : saved;
          if (Boolean(upload) === (tab === "yes")) {
            records.push(record);
            if (upload) uploads[String(record.docEntry)] = upload;
          }
          if (records.length === query.limit) {
            nextCursor =
              consumed < basic.length || page.nextCursor !== null
                ? Number(record.docEntry)
                : null;
            break;
          }
        }
        if (records.length === query.limit) break;
        nextCursor = page.nextCursor;
        if (nextCursor === null) break;
        cursor = nextCursor;
      }
      const poEntries = [
        ...new Set(
          records
            .flatMap((r) => r.lines)
            .filter((l) => l.baseType === 22 && l.baseEntry !== null)
            .map((l) => l.baseEntry!),
        ),
      ];
      const readUnuploaded = async () => {
        if (allPageUploads) {
          const states = await allPageUploads;
          for (const [entry, state] of Object.entries(states)) {
            if (!state.deleted) uploads[entry] = state;
          }
        }
        return records.filter((r) => !uploads[String(r.docEntry)]);
      };
      const unuploaded = readUnuploaded();
      const readPdfs = async (unuploaded: SapInspectorRecord[]) => {
        const attachmentEntries = [
          ...new Set(
            unuploaded.flatMap(({ raw }) => {
              const entry = raw.AttachmentEntry;
              return typeof entry === "number" &&
                Number.isSafeInteger(entry) &&
                entry > 0
                ? [entry]
                : [];
            }),
          ),
        ];
        const attachments =
          tab === "all"
            ? await client.listAttachmentMetadataByEntries(attachmentEntries)
            : new Map<number, Record<string, unknown>>();
        const pdfs = await grpoPdfAvailability(unuploaded, async (entry) => {
          if (tab === "all") return attachments.get(entry) ?? {};
          const metadata = await client.getAttachmentMetadata(entry);
          attachments.set(entry, metadata);
          return metadata;
        });
        return { pdfs, attachments };
      };
      const pdfDetails = unuploaded.then(readPdfs);
      const readAutomation = async () => {
        const states: Record<string, GrpoAutomaticStatus> = {};
        if (!automatic) return { states, posted: {} };
        const [rows, { pdfs, attachments }] = await Promise.all([
          unuploaded,
          pdfDetails,
        ]);
        const today = new Date(Date.now() + 330 * 60_000)
          .toISOString()
          .slice(0, 10);
        const candidates = rows.filter((row) => {
          const entry = String(row.docEntry);
          if (pdfs[entry]?.status !== "available") return false;
          if (!grpoVendorInvoiceReference(row.raw, config.invoiceRefField)) {
            states[entry] = "missing_invoice_reference";
            return false;
          }
          return Boolean(
            automaticGrpoCandidate(
              row.raw,
              attachments.get(Number(row.raw.AttachmentEntry)),
              automatic.fromDate,
              today,
              config.invoiceRefField,
            ),
          );
        });
        const entries = candidates.map((row) => Number(row.docEntry));
        let posted = {};
        if (entries.length) {
          try {
            const [history, postedInvoices] = await Promise.all([
              readAutomaticGrpoImportHistory(
                db,
                company,
                entries,
                automatic.owner,
              ),
              grpoExistingApDocuments(
                candidates,
                config.invoiceRefField,
                (refs) =>
                  client.listApDocumentsByVendorReferences(refs, "posted"),
                "posted",
              ),
            ]);
            posted = postedInvoices;
            for (const entry of entries) {
              const prior = history.get(entry);
              if (!postedInvoices[String(entry)])
                states[String(entry)] =
                  prior?.activeCaseId && !prior.resumeCaseId
                    ? "case_exists"
                    : "waiting";
            }
          } catch {
            for (const entry of entries) states[String(entry)] = "unavailable";
          }
        }
        for (const [entry, upload] of Object.entries(uploads))
          if (
            upload.automatic &&
            upload.status === "draft" &&
            upload.sapDraft?.status === "not_created"
          )
            states[entry] = "waiting";
        return { states, posted };
      };
      const [purchaseOrders, { pdfs }, drafts, automation] = await Promise.all([
        poEntries.length
          ? client.listPurchaseOrdersByEntries(
              poEntries,
              tab === "all" ? 40 : 15,
            )
          : [],
        pdfDetails,
        unuploaded.then((rows) =>
          grpoExistingApDocuments(
            rows,
            config.invoiceRefField,
            client.listApDocumentsByVendorReferences,
          ).catch(() => {
            console.warn(
              "Could not verify existing SAP drafts for unbilled receipts.",
            );
            return {};
          }),
        ),
        readAutomation(),
      ]);
      return {
        pdfs,
        drafts: { ...drafts, ...automation.posted },
        automaticStatuses: automation.states,
        records: normalizeSapInspectorRecords(
          "grpo",
          records.map((r) => r.raw),
          {
            purchaseOrders,
            poReferenceFields: config.poRefFields,
            vehicleField: config.vehicleField,
            invoiceField: config.invoiceRefField,
            eWayBillField: config.eWayBillField,
            lorryReceiptField: config.lorryReceiptField,
          },
        ),
        uploads,
        nextCursor,
        fetchedAt: new Date().toISOString(),
        company,
        environment,
      };
    });
  });
}
