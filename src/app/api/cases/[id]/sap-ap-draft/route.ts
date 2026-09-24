import { NextResponse } from "next/server";

import { ApiError, dbCheck, jsonBody, ownedCase, uuid, withUser } from "@/server/api/helpers";
import { readStoredLineItems } from "@/server/line-items";
import { classifySapCase, matchSapReference, normalizeSapReference, parseSapAmount, scoreVendorNames } from "@/lib/sap-decision";
import { readSapEnvironment } from "@/server/sap/config";
import { buildApInvoiceDraft, buildPoApInvoiceDraft } from "@/server/sap/ap-draft";
import { sapInvoiceDate, sapPostingDate } from "@/server/sap/dates";
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
    const body = (await jsonBody(request)) as {
      baseGrpoDocNum?: unknown;
      baseGrpoDocEntry?: unknown;
      basePoDocNum?: unknown;
      basePoDocEntry?: unknown;
    } | null;
    const requestedGrpoDocNum =
      typeof body?.baseGrpoDocNum === "string" && body.baseGrpoDocNum.trim()
        ? body.baseGrpoDocNum.trim()
        : null;
    const requestedPoDocNum =
      typeof body?.basePoDocNum === "string" && body.basePoDocNum.trim()
        ? body.basePoDocNum.trim()
        : null;
    if (requestedGrpoDocNum && requestedPoDocNum) {
      throw new ApiError("Select either one SAP GRPO or one SAP purchase order, not both.", 409);
    }
    const baseKind = requestedPoDocNum ? "PO" : "GRPO";
    const requestedEntry = Number(baseKind === "PO" ? body?.basePoDocEntry : body?.baseGrpoDocEntry);
    if ((baseKind === "PO" ? body?.basePoDocEntry : body?.baseGrpoDocEntry) != null &&
        (!Number.isInteger(requestedEntry) || requestedEntry <= 0)) {
      throw new ApiError("The selected SAP document entry is invalid.", 409);
    }

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
    const invoiceDate = sapInvoiceDate(invoiceFields.documentDate);
    if (!invoiceDate) {
      throw new ApiError("The vendor invoice date is missing or unreadable. Review it before creating an SAP draft.", 409);
    }
    const postingDate = sapPostingDate();
    const invoiceTotal = parseSapAmount(invoiceFields.totalAmount);
    if (invoiceTotal === null || invoiceTotal <= 0) {
      throw new ApiError("The vendor invoice needs a positive total before creating an SAP draft.", 409);
    }
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

    const openRows = baseKind === "GRPO" ? await fetchTestOpenGrpoRows() : [];
    const baseDocNum = requestedPoDocNum ?? requestedGrpoDocNum ?? matchSapReference(
      classification.poNumber,
      openRows.map((candidate) => candidate.DocNum).filter(
        (value): value is string | number => typeof value === "string" || typeof value === "number",
      ),
    );
    if (!baseDocNum) {
      throw new ApiError("Select a matching open SAP GRPO or purchase order before creating an AP draft.", 409);
    }
    if (baseKind === "PO" && (!/^\d+$/.test(baseDocNum) ||
        normalizeSapReference(classification.poNumber) !== normalizeSapReference(baseDocNum))) {
      throw new ApiError("The selected SAP purchase order number must match the uploaded packet.", 409);
    }
    const baseRows = openRows.filter((candidate) =>
      String(candidate.DocNum ?? "") === baseDocNum &&
      (!Number.isInteger(requestedEntry) || Number(candidate.DocEntry) === requestedEntry),
    );
    const entries = [...new Set(baseRows.map((candidate) => Number(candidate.DocEntry)))];
    const cardCodes = [...new Set(baseRows.map((candidate) => String(candidate["BP Code"] ?? "").trim()))];
    if (baseKind === "GRPO" && (entries.length !== 1 || !Number.isInteger(entries[0]) || entries[0] <= 0 ||
        cardCodes.length !== 1 || !cardCodes[0])) {
      throw new ApiError("The selected SAP GRPO has ambiguous document or vendor details.", 409);
    }

    const comment = `Samrat case ${id} AP invoice draft`;
    let result: { DocEntry?: number; DocNum?: number; CardCode?: string; Comments?: string };
    let alreadyCreated = false;
    let selectedEntry = entries[0] ?? 0;
    let selectedCardCode = cardCodes[0] ?? "";
    try {
      result = await withTestServiceLayer(async (client) => {
        const baseDocument = baseKind === "GRPO"
          ? await client.getGrpo(selectedEntry)
          : await (async () => {
              const candidates = await client.listPurchaseOrdersByDocNum(Number(baseDocNum));
              const openCandidates = candidates.filter((candidate) =>
                candidate.Cancelled === "tNO" && candidate.DocumentStatus === "bost_Open" &&
                scoreVendorNames(invoiceVendor, candidate.CardName) >= 0.8 &&
                (!Number.isInteger(requestedEntry) || candidate.DocEntry === requestedEntry),
              );
              if (openCandidates.length !== 1 || !openCandidates[0].DocEntry) {
                throw new ApiError("The selected open SAP purchase order is missing or ambiguous; review its document number and vendor.", 409);
              }
              selectedEntry = openCandidates[0].DocEntry;
              selectedCardCode = openCandidates[0].CardCode ?? "";
              return client.getPurchaseOrder(selectedEntry);
            })();
        if (String(baseDocument.DocNum ?? "") !== baseDocNum ||
            baseDocument.DocEntry !== selectedEntry ||
            baseDocument.CardCode !== selectedCardCode) {
          throw new ApiError("The SAP base document changed since it was selected. Refresh the SAP match.", 409);
        }
        const invoiceCurrency = String(invoiceFields.currency ?? "").trim().toUpperCase();
        if (invoiceCurrency && invoiceCurrency !== baseDocument.DocCurrency?.toUpperCase()) {
          throw new ApiError("The vendor invoice currency differs from the selected SAP document.", 409);
        }
        const existingInvoice = await client.findInvoiceByReference(selectedCardCode, classification.invoiceNumber!);
        if (existingInvoice) {
          throw new ApiError(
            `A posted SAP Test AP invoice ${existingInvoice.DocNum ?? existingInvoice.DocEntry} already uses this vendor invoice number. No draft was created.`,
            409,
          );
        }
        {
          const sameAmount = await client.listInvoicesByAmount(selectedCardCode, invoiceTotal);
          const basedOnDocument = sameAmount.find((document) =>
            document.Cancelled === "tNO" && (document.DocumentLines ?? []).some(
              (line) => line.BaseType === (baseKind === "GRPO" ? 20 : 22) && line.BaseEntry === selectedEntry,
            ),
          );
          if (basedOnDocument) {
            throw new ApiError(
              `A posted SAP Test AP invoice ${basedOnDocument.DocNum ?? basedOnDocument.DocEntry} is already linked to this ${baseKind}. No draft was created.`,
              409,
            );
          }
        }
        let payload: ReturnType<typeof buildApInvoiceDraft>;
        try {
          const shared = {
            expectedDocEntry: selectedEntry,
            expectedDocNum: baseDocNum,
            expectedCardCode: selectedCardCode,
            invoiceVendor,
            invoiceNumber: classification.invoiceNumber!,
            invoiceLines,
            caseId: id,
            postingDate,
            invoiceDate,
          };
          payload = baseKind === "GRPO"
            ? buildApInvoiceDraft({ ...shared, grpo: baseDocument })
            : buildPoApInvoiceDraft({ ...shared, po: baseDocument });
        } catch (error) {
          throw new ApiError(error instanceof Error ? error.message : "Invoice and SAP document do not match.", 409);
        }
        const previous = await client.findDraft(comment);
        if (previous) {
          if (previous.CardCode !== selectedCardCode) {
            throw new ApiError("An SAP draft for this case has a different vendor; review it in SAP.", 409);
          }
          alreadyCreated = true;
          return previous;
        }
        const currencies = await client.getAdminCurrencies();
        if (!currencies.LocalCurrency || !currencies.SystemCurrency) {
          throw new ApiError("SAP Test did not return its local and system currencies; no draft was created.", 409);
        }
        const requiredRates = new Set(
          [currencies.SystemCurrency, baseDocument.DocCurrency]
            .filter((currency): currency is string => Boolean(currency) && currency !== currencies.LocalCurrency),
        );
        for (const currency of requiredRates) {
          try {
            await client.getCurrencyRate(currency, postingDate);
          } catch (error) {
            if (/update the exchange rate|no valid .* exchange rate/i.test(String(error))) {
              throw new ApiError(
                `SAP Test is missing the ${currency} exchange rate for posting date ${postingDate}. Ask the SAP administrator to maintain that day's rate, then retry. No draft was created.`,
                409,
              );
            }
            throw error;
          }
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
          baseKind,
          baseDocNum,
          baseDocEntry: selectedEntry,
          invoiceNumber: classification.invoiceNumber,
          postingDate,
          invoiceDate,
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
      details: { sapEnv: "test", docEntry: result.DocEntry, baseKind, baseDocNum, baseDocEntry: selectedEntry },
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
