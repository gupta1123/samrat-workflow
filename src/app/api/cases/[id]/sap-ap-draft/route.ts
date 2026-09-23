import { NextResponse } from "next/server";

import { ApiError, dbCheck, jsonBody, ownedCase, uuid, withUser } from "@/server/api/helpers";
import { readStoredLineItems } from "@/server/line-items";
import { classifySapCase, matchSapReference, parseSapAmount } from "@/lib/sap-decision";
import { readSapEnvironment } from "@/server/sap/config";
import { buildApInvoiceDraft } from "@/server/sap/ap-draft";
import { fetchTestOpenGrpoRows, withTestServiceLayer } from "@/server/sap/service-layer";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  return withUser(request, async (db, user) => {
    if (readSapEnvironment() !== "test") {
      throw new ApiError("AP Invoice Draft creation is enabled only for the SAP Test company.", 409);
    }
    const { id } = await context.params;
    const row = await ownedCase(db, user, id);
    if (row.status !== "accepted") {
      throw new ApiError("Approve the case before creating an SAP draft.", 409);
    }
    const body = (await jsonBody(request)) as { baseGrpoDocNum?: unknown } | null;
    const requestedDocNum =
      typeof body?.baseGrpoDocNum === "string" && body.baseGrpoDocNum.trim()
        ? body.baseGrpoDocNum.trim()
        : null;

    const documentsResult = await db
      .from("packet_documents")
      .select("document_type, extracted_fields")
      .eq("case_id", id)
      .order("created_at");
    dbCheck(documentsResult.error);
    const documents = documentsResult.data ?? [];
    const classification = classifySapCase({
      casePoNumber: row.po_number,
      caseInvoiceNumber: row.invoice_number,
      documents: documents.map((document, index) => ({
        id: String(index),
        documentType: String(document.document_type ?? ""),
        extractedFields: document.extracted_fields as Record<string, unknown>,
      })),
    });
    if (!classification.hasVendorInvoice || !classification.invoiceNumber) {
      throw new ApiError("This approved case needs a numbered vendor invoice before an AP draft can be created.", 409);
    }
    const invoice = documents.find((document) => {
      if (document.document_type !== "Invoice" && document.document_type !== "Tax Invoice") return false;
      const fields = document.extracted_fields as Record<string, unknown> | null;
      return String(fields?.invoiceNumber ?? "").trim() === classification.invoiceNumber;
    });
    if (!invoice) throw new ApiError("The case invoice number does not match an uploaded vendor invoice.", 409);
    const invoiceFields = (invoice.extracted_fields ?? {}) as Record<string, unknown>;
    const invoiceVendor = String(invoiceFields.vendorName ?? invoiceFields.supplierName ?? "").trim();
    const invoiceLines = readStoredLineItems(invoice.extracted_fields).map((line) => ({
      itemCode: line.itemCode,
      description: line.description,
      quantity: line.quantity,
    }));

    const existingResult = await db
      .from("sap_postings")
      .select("status, sap_docnum, response")
      .eq("case_id", uuid(id))
      .eq("owner_user_id", user)
      .eq("kind", "AP")
      .eq("sap_env", "test")
      .maybeSingle();
    dbCheck(existingResult.error);
    if (existingResult.data?.sap_docnum &&
        (existingResult.data.status === "prepared" || existingResult.data.status === "posted")) {
      return {
        ok: true,
        alreadyCreated: true,
        draft: existingResult.data.status === "prepared",
        docEntry: existingResult.data.sap_docnum,
        message: existingResult.data.status === "prepared"
          ? `SAP Test AP Invoice Draft ${existingResult.data.sap_docnum} already exists for this case.`
          : "An AP invoice was already posted for this case; no draft was created.",
      };
    }

    const openRows = await fetchTestOpenGrpoRows();
    const baseDocNum = requestedDocNum ?? matchSapReference(
      classification.poNumber,
      openRows.map((candidate) => candidate.DocNum).filter(
        (value): value is string | number => typeof value === "string" || typeof value === "number",
      ),
    );
    if (!baseDocNum) {
      throw new ApiError("Select a matching open SAP GRPO before creating an AP draft.", 409);
    }
    const baseRows = openRows.filter((candidate) => String(candidate.DocNum ?? "") === baseDocNum);
    const entries = [...new Set(baseRows.map((candidate) => Number(candidate.DocEntry)))];
    const cardCodes = [...new Set(baseRows.map((candidate) => String(candidate["BP Code"] ?? "").trim()))];
    if (entries.length !== 1 || !Number.isInteger(entries[0]) || entries[0] <= 0 ||
        cardCodes.length !== 1 || !cardCodes[0]) {
      throw new ApiError("The selected SAP GRPO has ambiguous document or vendor details.", 409);
    }

    const comment = `Samrat case ${id} AP invoice draft`;
    let result: { DocEntry?: number; DocNum?: number; CardCode?: string; Comments?: string };
    let alreadyCreated = false;
    try {
      result = await withTestServiceLayer(async (client) => {
        const grpo = await client.getGrpo(entries[0]);
        const existingInvoice = await client.findInvoiceByReference(cardCodes[0], classification.invoiceNumber!);
        if (existingInvoice) {
          throw new ApiError(
            `A posted SAP Test AP invoice ${existingInvoice.DocNum ?? existingInvoice.DocEntry} already uses this vendor invoice number. No draft was created.`,
            409,
          );
        }
        const invoiceTotal = parseSapAmount(invoiceFields.totalAmount);
        if (invoiceTotal !== null) {
          const sameAmount = await client.listInvoicesByAmount(cardCodes[0], invoiceTotal);
          const basedOnGrpo = sameAmount.find((document) =>
            document.Cancelled === "tNO" && (document.DocumentLines ?? []).some(
              (line) => line.BaseType === 20 && line.BaseEntry === entries[0],
            ),
          );
          if (basedOnGrpo) {
            throw new ApiError(
              `A posted SAP Test AP invoice ${basedOnGrpo.DocNum ?? basedOnGrpo.DocEntry} is already linked to this GRPO. No draft was created.`,
              409,
            );
          }
        }
        let payload: ReturnType<typeof buildApInvoiceDraft>;
        try {
          payload = buildApInvoiceDraft({
            grpo,
            expectedDocEntry: entries[0],
            expectedDocNum: baseDocNum,
            expectedCardCode: cardCodes[0],
            invoiceVendor,
            invoiceNumber: classification.invoiceNumber!,
            invoiceLines,
            caseId: id,
          });
        } catch (error) {
          throw new ApiError(error instanceof Error ? error.message : "Invoice and GRPO do not match.", 409);
        }
        const previous = await client.findDraft(comment);
        if (previous) {
          if (previous.CardCode !== cardCodes[0]) {
            throw new ApiError("An SAP draft for this case has a different vendor; review it in SAP.", 409);
          }
          alreadyCreated = true;
          return previous;
        }
        return client.createDraft(payload);
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      return NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : "SAP Test draft creation failed." },
        { status: 502 },
      );
    }
    if (!Number.isInteger(result.DocEntry) || !result.DocEntry) {
      return NextResponse.json(
        { ok: false, error: "SAP may have created the draft but did not return its entry number. Check SAP before retrying." },
        { status: 502 },
      );
    }

    const saved = await db.from("sap_postings").upsert(
      {
        case_id: uuid(id),
        owner_user_id: user,
        kind: "AP",
        status: "prepared",
        sap_env: "test",
        sap_docnum: String(result.DocEntry),
        payload: {
          documentType: "APInvoiceDraft",
          caseId: id,
          baseGrpoDocNum: baseDocNum,
          baseGrpoDocEntry: entries[0],
          invoiceNumber: classification.invoiceNumber,
        },
        response: {
          DocEntry: result.DocEntry,
          DocNum: result.DocNum,
          CardCode: result.CardCode,
        },
        error: null,
      },
      { onConflict: "case_id,kind,sap_env" },
    );
    dbCheck(saved.error);
    const event = await db.from("case_review_events").insert({
      case_id: id,
      owner_user_id: user,
      action: alreadyCreated ? "sap_ap_draft_linked" : "sap_ap_draft_created",
      details: { sapEnv: "test", docEntry: result.DocEntry, baseGrpoDocNum: baseDocNum },
    });
    if (event.error) console.error("Could not record SAP draft event:", event.error.message);

    return {
      ok: true,
      draft: true,
      alreadyCreated,
      docEntry: result.DocEntry,
      docNum: result.DocNum,
      message: alreadyCreated
        ? `Existing SAP Test AP Invoice Draft ${result.DocEntry} linked to this case.`
        : `SAP Test AP Invoice Draft ${result.DocEntry} created. No invoice was posted.`,
    };
  });
}
