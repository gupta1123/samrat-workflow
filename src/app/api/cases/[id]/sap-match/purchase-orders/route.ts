import {
  ApiError,
  dbCheck,
  ownedCase,
  uuid,
  withUser,
} from "@/server/api/helpers";
import { readSapEnvironment } from "@/server/sap/config";
import { readSapMatchJob } from "@/server/sap/match-job";
import { postedSapDetails } from "@/lib/sap-posted-details";
import { fetchSapOpenPOs } from "@/server/sap/client";
import { withTestServiceLayer } from "@/server/sap/service-layer";
import {
  selectedOrderEntries,
  supplierOrders,
  supplierInvoiceNumbers,
  type SupplierInvoiceReferencesResponse,
  type SupplierOrdersResponse,
} from "@/lib/sap-match/supplier-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** On-demand, read-only list. Supplier identity comes from the owned case. */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    await ownedCase(db, user, id);
    if (readSapEnvironment() !== "test")
      throw new ApiError("Supplier POs are available for SAP Test.", 409);
    const job = await readSapMatchJob(db, user, id);
    const posting = await db
      .from("sap_postings")
      .select("status, sap_docnum, payload, response, updated_at")
      .eq("case_id", uuid(id))
      .eq("owner_user_id", user)
      .eq("kind", "AP")
      .eq("sap_env", "test")
      .in("status", ["prepared", "posted"])
      .maybeSingle();
    dbCheck(posting.error);
    const saved = posting.data ? postedSapDetails(posting.data).match : null;
    const match = saved ?? (job?.result?.available ? job.result : null);
    if (!match?.vendor)
      throw new ApiError(
        "Identify the supplier in SAP matching before viewing its POs.",
        409,
      );
    const { vendor, result } = match;
    if (new URL(request.url).searchParams.get("invoiceReferences") === "1") {
      try {
        return await withTestServiceLayer(async (client) => {
          const [receipts, invoices] = await Promise.allSettled([
            client.listSupplierInvoiceDocuments(vendor.cardCode, "grpo"),
            client.listSupplierInvoiceDocuments(vendor.cardCode, "ap-invoice"),
          ]);
          const warnings: string[] = [];
          for (const [label, read] of [
            ["GRPO", receipts],
            ["A/P invoice", invoices],
          ] as const) {
            if (read.status === "rejected")
              warnings.push(`${label} invoice references unavailable.`);
            else if (!read.value.complete)
              warnings.push(
                `${label} invoice history partially loaded; older references may be missing.`,
              );
          }
          const response: SupplierInvoiceReferencesResponse = {
            invoicesByPo: supplierInvoiceNumbers(
              vendor.cardCode,
              receipts.status === "fulfilled" ? receipts.value.rows : [],
              invoices.status === "fulfilled" ? invoices.value.rows : [],
            ),
            lookup:
              receipts.status === "rejected" && invoices.status === "rejected"
                ? "unavailable"
                : warnings.length
                  ? "partial"
                  : "complete",
            warnings,
          };
          return response;
        });
      } catch {
        throw new ApiError(
          "Supplier invoice references unavailable. Try again.",
          502,
        );
      }
    }
    const entries = selectedOrderEntries(result.lines);
    const reads = await Promise.allSettled([
      withTestServiceLayer(async (client) => {
        const [open, linked] = await Promise.all([
          client.listOpenPurchaseOrdersForVendor(vendor.cardCode),
          entries.length
            ? client.listPurchaseOrdersByEntries(entries)
            : Promise.resolve([]),
        ]);
        const unique = new Map(
          [...open, ...linked].map((order) => [order.DocEntry, order]),
        );
        return { rows: [...unique.values()], limited: open.length >= 1000 };
      }),
      fetchSapOpenPOs("test"),
    ]);
    const [service, report] = reads;
    if (service.status === "rejected" && report.status === "rejected")
      throw new ApiError(
        "Could not load supplier POs from SAP. Try again.",
        502,
      );
    const warnings: string[] = [];
    if (service.status === "rejected")
      warnings.push(
        "SAP Purchase Orders unavailable; selection links could not be verified against current SAP data.",
      );
    else if (service.value.limited)
      warnings.push(
        "Showing up to 1,000 open SAP POs, plus linked selected POs.",
      );
    if (report.status === "rejected")
      warnings.push("Open PO report unavailable.");
    const response: SupplierOrdersResponse = {
      vendor,
      checkedAt: new Date().toISOString(),
      warnings,
      orders: [
        ...(service.status === "fulfilled"
          ? supplierOrders(
              service.value.rows,
              vendor.cardCode,
              result.lines,
              "service-layer",
            )
          : []),
        ...(report.status === "fulfilled"
          ? supplierOrders(report.value, vendor.cardCode, result.lines, "spapi")
          : []),
      ],
    };
    return response;
  });
}
