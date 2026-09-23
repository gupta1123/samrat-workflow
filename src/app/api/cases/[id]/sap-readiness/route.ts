import { dbCheck, ownedCase, uuid, withUser } from "@/server/api/helpers";
import { fetchSapOpenGRPOs, fetchSapOpenPOs } from "@/server/sap/client";
import { readSapEnvironment } from "@/server/sap/config";
import { fetchTestOpenGrpoRows } from "@/server/sap/service-layer";
import {
  classifySapCase,
  matchSapReference,
  parseSapAmount,
  rankSapCandidates,
} from "@/lib/sap-decision";

type Context = { params: Promise<{ id: string }> };

function docNums(rows: Record<string, unknown>[]): Array<string | number> {
  const out: Array<string | number> = [];
  for (const row of rows) {
    const value = row.DocNum;
    if (typeof value === "string" || typeof value === "number") out.push(value);
  }
  return out;
}

export async function GET(request: Request, context: Context) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    const row = await ownedCase(db, user, id);

    const documentsResult = await db
      .from("packet_documents")
      .select("client_document_id, document_type, extracted_fields")
      .eq("case_id", id)
      .order("created_at");
    dbCheck(documentsResult.error);

    const documents = (documentsResult.data ?? []).map((d) => ({
      id: String(d.client_document_id ?? ""),
      documentType: String(d.document_type ?? ""),
      extractedFields:
        d.extracted_fields && typeof d.extracted_fields === "object"
          ? (d.extracted_fields as Record<string, unknown>)
          : {},
    }));

    const classification = classifySapCase({
      casePoNumber: row.po_number,
      caseInvoiceNumber: row.invoice_number,
      documents,
    });

    const sapEnv = readSapEnvironment();
    let openPOs: Record<string, unknown>[] = [];
    let openGRPOs: Record<string, unknown>[] = [];
    let sapError: string | null = null;
    const [poResult, grpoResult] = await Promise.allSettled([
      fetchSapOpenPOs(sapEnv),
      sapEnv === "test" ? fetchTestOpenGrpoRows() : fetchSapOpenGRPOs(sapEnv),
    ]);
    if (poResult.status === "fulfilled") openPOs = poResult.value;
    if (grpoResult.status === "fulfilled") openGRPOs = grpoResult.value;
    else sapError = grpoResult.reason instanceof Error
      ? grpoResult.reason.message
      : "Could not reach SAP GRPOs.";

    const matchedPoDocNum = matchSapReference(classification.poNumber, docNums(openPOs));
    const matchedGrpoDocNum = matchSapReference(classification.poNumber, docNums(openGRPOs));

    // Real PO numbers never equal SAP's integer DocNums, so when the direct
    // match misses, rank open rows by vendor overlap + total proximity and
    // let the reviewer pick the base document.
    const primaryInvoice = documents.find(
      (d) => d.documentType === "Invoice" || d.documentType === "Tax Invoice",
    );
    const caseVendor =
      (primaryInvoice?.extractedFields.vendorName as string | undefined) ??
      row.buyer_name;
    const caseTotal =
      parseSapAmount(primaryInvoice?.extractedFields.totalAmount) ??
      parseSapAmount(primaryInvoice?.extractedFields.subtotal);
    const toCandidateRows = (rows: Record<string, unknown>[]) =>
      [...new Map(rows.map((r) => [String(r.DocNum ?? ""), r])).values()].map((r) => ({
        docNum: (r.DocNum as string | number) ?? "",
        vendorName: r["BP Name"],
        totalAmount: r["Total Amount"],
        itemDescription: r.Dscription,
        docDate: r["Doc Date"],
      }));
    const candidatePOs = rankSapCandidates({
          caseVendor,
          caseTotal,
          rows: toCandidateRows(openPOs),
        });
    const candidateGRPOs = rankSapCandidates({
          caseVendor,
          caseTotal,
          rows: toCandidateRows(openGRPOs),
        });

    const postingsResult = await db
      .from("sap_postings")
      .select("kind, status, sap_env, sap_docnum, error, created_at, updated_at")
      .eq("case_id", uuid(id))
      .eq("owner_user_id", user)
      .order("created_at");
    dbCheck(postingsResult.error);

    return {
      sapEnv,
      caseStatus: row.status,
      postable: row.status === "accepted",
      classification,
      openPoCount: openPOs.length,
      openGrpoCount: new Set(docNums(openGRPOs).map(String)).size,
      matchedPoDocNum,
      matchedGrpoDocNum,
      candidatePOs,
      candidateGRPOs,
      caseVendor: typeof caseVendor === "string" ? caseVendor : null,
      caseTotal,
      sapError,
      postings: postingsResult.data ?? [],
    };
  });
}
