import {
  normalizeSapInspectorRecords,
  type SapInspectorDataset,
  type SapInspectorResponse,
} from "@/lib/sap-inspector";
import { ApiError, withUser } from "@/server/api/helpers";
import {
  clearSapCache,
  fetchSapOpenGRPOs,
  fetchSapOpenPOs,
} from "@/server/sap/client";
import { readSapEnvironment } from "@/server/sap/config";
import { withTestServiceLayer } from "@/server/sap/service-layer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATASETS = new Set<SapInspectorDataset>([
  "open-po",
  "po",
  "grpo",
  "ap-invoice",
]);

function datasetFrom(value: string | null): SapInspectorDataset {
  if (value && DATASETS.has(value as SapInspectorDataset)) {
    return value as SapInspectorDataset;
  }
  throw new ApiError("Choose Open PO, PO, GRPO, or AP Invoice.", 400);
}

function readLimit(value: string | null) {
  const parsed = Number(value ?? 250);
  if (!Number.isFinite(parsed)) return 250;
  return Math.max(25, Math.min(500, Math.floor(parsed)));
}

function configuredPoReferenceFields() {
  return (process.env.SAP_PO_REF_FIELDS ?? "")
    .split(",")
    .map((field) => field.trim())
    .filter((field) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field));
}

export async function GET(request: Request) {
  return withUser(request, async () => {
    const search = new URL(request.url).searchParams;
    const dataset = datasetFrom(search.get("dataset"));
    const limit = readLimit(search.get("limit"));
    const poReferenceFields = configuredPoReferenceFields();
    const vehicleField = (process.env.SAP_GRPO_VEHICLE_FIELD ?? "").trim();

    try {
      if (dataset === "open-po" || dataset === "grpo") {
        if (search.get("refresh") === "1") clearSapCache();
        const environment = readSapEnvironment();
        const rows =
          dataset === "open-po"
            ? await fetchSapOpenPOs(environment)
            : await fetchSapOpenGRPOs(environment);
        const selected = rows.slice(0, limit);
        const response: SapInspectorResponse = {
          dataset,
          source: "SPAPI",
          environment,
          fetchedAt: new Date().toISOString(),
          limit,
          truncated: rows.length > selected.length,
          records: normalizeSapInspectorRecords(dataset, selected, {
            feed: "spapi",
            poReferenceFields,
            vehicleField,
          }),
        };
        return response;
      }

      const additionalFields = dataset === "po" ? poReferenceFields : [];
      const rows = await withTestServiceLayer((client) =>
        client.listInspectorDocuments(dataset, limit, additionalFields),
      );
      const response: SapInspectorResponse = {
        dataset,
        source: "SAP Business One Service Layer",
        environment: "test",
        fetchedAt: new Date().toISOString(),
        limit,
        truncated: rows.length >= limit,
        records: normalizeSapInspectorRecords(dataset, rows, {
          poReferenceFields,
          vehicleField,
        }),
      };
      return response;
    } catch (error) {
      console.error("SAP inspector read failed", {
        dataset,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ApiError(
        `Could not read ${dataset === "ap-invoice" ? "AP Invoices" : dataset.toUpperCase()} from SAP. Check the configured SAP connection and try again.`,
        502,
      );
    }
  });
}
