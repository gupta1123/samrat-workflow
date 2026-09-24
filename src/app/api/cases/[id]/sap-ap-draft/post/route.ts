import {
  ApiError,
  dbCheck,
  ownedCase,
  uuid,
  withUser,
} from "@/server/api/helpers";
import { readStoredLineItems } from "@/server/line-items";
import { readSapEnvironment } from "@/server/sap/config";
import { invoiceMoneyPreview } from "@/server/sap/preview";
import { withTestServiceLayer } from "@/server/sap/service-layer";

type Context = { params: Promise<{ id: string }> };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function dateOnly(value: unknown): string {
  const valueText = text(value);
  return /^\d{4}-\d{2}-\d{2}/.test(valueText) ? valueText.slice(0, 10) : "";
}

function materialFormFields(value: unknown): Record<string, unknown> {
  const source = record(value);
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        key.startsWith("U_") && /material|mat.*form|form.*mat/i.test(key),
    ),
  );
}

async function handle(
  request: Request,
  context: Context,
  convertToFinalInvoice: boolean,
) {
  return withUser(request, async (db, user) => {
    if (readSapEnvironment() !== "test") {
      throw new ApiError(
        "Final draft posting through this app is enabled only in SAP Test.",
        409,
      );
    }

    const { id } = await context.params;
    const caseRow = await ownedCase(db, user, id);
    if (convertToFinalInvoice && caseRow.status !== "accepted") {
      throw new ApiError(
        "Approve the case before posting its SAP Test draft.",
        409,
      );
    }

    const postingResult = await db
      .from("sap_postings")
      .select("status, sap_docnum, payload, response")
      .eq("case_id", uuid(id))
      .eq("owner_user_id", user)
      .eq("kind", "AP")
      .eq("sap_env", "test")
      .maybeSingle();
    dbCheck(postingResult.error);
    const posting = postingResult.data;
    if (!posting) {
      throw new ApiError(
        "No SAP Test AP invoice draft exists for this case.",
        404,
      );
    }
    if (posting.status === "posted" && posting.sap_docnum) {
      return {
        ok: true,
        alreadyPosted: true,
        posted: true,
        docNum: posting.sap_docnum,
        message: `SAP Test AP Invoice ${posting.sap_docnum} is already posted.`,
      };
    }
    if (posting.status !== "prepared") {
      throw new ApiError(
        "This case does not have a prepared SAP Test AP invoice draft.",
        409,
      );
    }

    const draftDocEntry = positiveInteger(posting.sap_docnum);
    if (!draftDocEntry) {
      throw new ApiError("The saved SAP Test draft number is invalid.", 409);
    }
    const payload = record(posting.payload);
    const previousResponse = record(posting.response);
    const expectedVendorCode = text(previousResponse.CardCode);
    const expectedInvoiceNumber =
      text(payload.invoiceNumber) || text(caseRow.invoice_number);
    const expectedPostingDate = dateOnly(payload.postingDate);
    const expectedInvoiceDate = dateOnly(payload.invoiceDate);
    const expectedBaseEntry = positiveInteger(payload.baseDocEntry);
    const expectedBaseType = payload.baseKind === "PO" ? 22 : 20;
    if (
      !expectedVendorCode ||
      !expectedInvoiceNumber ||
      !expectedPostingDate ||
      !expectedInvoiceDate ||
      !expectedBaseEntry
    ) {
      throw new ApiError(
        "The saved draft audit details are incomplete. No final invoice was posted.",
        409,
      );
    }

    const documentsResult = await db
      .from("packet_documents")
      .select("document_type, extracted_fields")
      .eq("case_id", id)
      .order("created_at");
    dbCheck(documentsResult.error);
    const invoiceDocuments = (documentsResult.data ?? []).filter(
      (document) =>
        document.document_type === "Invoice" ||
        document.document_type === "Tax Invoice",
    );
    const packetLines = invoiceDocuments.flatMap((document) =>
      readStoredLineItems(document.extracted_fields).map((item) => ({
        description:
          typeof item.description === "string" ? item.description : undefined,
        quantity: item.quantity,
        rate: item.rate,
        taxableAmount: item.taxableAmount,
        taxAmount: item.taxAmount,
        lineTotal: item.lineTotal,
      })),
    );
    const expectedTotal = invoiceMoneyPreview(invoiceDocuments, packetLines)
      .totals.total;
    const invoiceFields = record(invoiceDocuments[0]?.extracted_fields);
    const expectedCurrency = text(invoiceFields.currency).toUpperCase();
    if (expectedTotal === null || expectedTotal <= 0) {
      throw new ApiError(
        "The vendor invoice total is unavailable. No final invoice was posted.",
        409,
      );
    }

    let result;
    try {
      result = await withTestServiceLayer(async (client) => {
        const existingInvoice = await client.findInvoiceByReference(
          expectedVendorCode,
          expectedInvoiceNumber,
        );
        if (existingInvoice) {
          return {
            alreadyPosted: true,
            invoice: existingInvoice,
            draft: null,
            serviceResult: {},
          };
        }

        const draft = await client.getDraft(draftDocEntry);
        const actualObject = text(draft.DocObjectCode);
        if (actualObject !== "18" && actualObject !== "oPurchaseInvoices") {
          throw new ApiError(
            "SAP Draft is not an A/P Invoice. No final invoice was posted.",
            409,
          );
        }
        if (
          draft.DocEntry !== draftDocEntry ||
          text(draft.Comments) !== `Samrat case ${id} AP invoice draft` ||
          text(draft.CardCode) !== expectedVendorCode ||
          text(draft.NumAtCard) !== expectedInvoiceNumber ||
          dateOnly(draft.DocDate) !== expectedPostingDate ||
          dateOnly(draft.TaxDate) !== expectedInvoiceDate
        ) {
          throw new ApiError(
            "SAP Draft no longer matches this case. No final invoice was posted.",
            409,
          );
        }
        if (
          expectedCurrency &&
          text(draft.DocCurrency).toUpperCase() !== expectedCurrency
        ) {
          throw new ApiError(
            "SAP Draft currency differs from the vendor invoice. No final invoice was posted.",
            409,
          );
        }
        const actualTotal = Number(draft.DocTotal);
        const totalTolerance = Math.max(1, expectedTotal * 0.00001);
        if (
          !Number.isFinite(actualTotal) ||
          Math.abs(actualTotal - expectedTotal) > totalTolerance
        ) {
          throw new ApiError(
            `SAP Draft total ${Number.isFinite(actualTotal) ? actualTotal.toFixed(2) : "is missing"} does not match the vendor invoice total ${expectedTotal.toFixed(2)}. No final invoice was posted.`,
            409,
          );
        }
        const lines = draft.DocumentLines ?? [];
        if (
          lines.length === 0 ||
          !lines.every(
            (line) =>
              line.BaseType === expectedBaseType &&
              line.BaseEntry === expectedBaseEntry,
          )
        ) {
          throw new ApiError(
            "SAP Draft is not based entirely on the selected PO/GRPO. No final invoice was posted.",
            409,
          );
        }

        const summary = {
          docEntry: draftDocEntry,
          vendorCode: draft.CardCode,
          vendorName: draft.CardName,
          invoiceNumber: draft.NumAtCard,
          currency: draft.DocCurrency,
          total: actualTotal,
          postingDate: expectedPostingDate,
          invoiceDate: expectedInvoiceDate,
          baseKind: payload.baseKind,
          baseDocument: payload.baseDocNum,
        };
        if (!convertToFinalInvoice) {
          return {
            alreadyPosted: false,
            invoice: null,
            draft: summary,
            serviceResult: {},
          };
        }

        let serviceResult: Record<string, unknown>;
        try {
          serviceResult = await client.finalizeDraft(draftDocEntry);
        } catch (error) {
          if (/please select the material form/i.test(String(error))) {
            const baseDocument =
              expectedBaseType === 22
                ? await client.getPurchaseOrder(expectedBaseEntry)
                : await client.getGrpo(expectedBaseEntry);
            const draftFields = materialFormFields(draft);
            const baseFields = materialFormFields(baseDocument);
            const userFields = (
              await Promise.all([
                client.listUserFields("OPCH"),
                client.listUserFields("PCH1"),
              ])
            )
              .flat()
              .filter((field) => /material\s*form/i.test(JSON.stringify(field)))
              .map((field) => ({
                tableName: field.TableName,
                name: field.Name,
                description: field.Description,
                validValues:
                  field.ValidValuesMD ??
                  field.ValidValues ??
                  field.ValidValuesCollection,
              }));
            console.error("SAP Test requires its custom Material Form field", {
              caseId: id,
              draftDocEntry,
              draftFields,
              baseFields,
              userFields,
            });
            const fieldNames = [
              ...new Set([
                ...Object.keys(draftFields),
                ...Object.keys(baseFields),
              ]),
            ];
            throw new ApiError(
              userFields.length > 0
                ? `SAP Test requires ${userFields
                    .map(
                      (field) =>
                        `${String(field.description ?? "Material Form")} (${String(field.name ?? "unknown field")})`,
                    )
                    .join(
                      ", ",
                    )} before this draft can be posted. No final invoice was posted.`
                : fieldNames.length > 0
                  ? `SAP Test requires its custom Material Form field before this draft can be posted. Relevant SAP field(s): ${fieldNames.join(", ")}. No final invoice was posted.`
                  : "SAP Test requires a client-specific Material Form value before this draft can be posted. The required field/value is not present on the PO or draft, so no final invoice was posted.",
              409,
              { draftFields, baseFields, userFields },
            );
          }
          throw error;
        }
        const invoice = await client.findInvoiceByReference(
          expectedVendorCode,
          expectedInvoiceNumber,
        );
        if (!invoice?.DocEntry) {
          throw new ApiError(
            "SAP accepted the draft conversion, but the final A/P Invoice could not be confirmed. Do not retry until it is checked in SAP Test.",
            502,
          );
        }
        return {
          alreadyPosted: false,
          invoice,
          draft: summary,
          serviceResult,
        };
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const detail =
        error instanceof Error
          ? error.message
          : "SAP Test did not complete the final posting.";
      console.error("SAP Test final AP invoice operation failed", {
        caseId: id,
        draftDocEntry,
        detail,
      });
      throw new ApiError(detail, 502);
    }

    if (!convertToFinalInvoice && result.draft) {
      return {
        ok: true,
        verified: true,
        posted: false,
        draft: result.draft,
        message: `SAP Test Draft ${draftDocEntry} exists and matches this case. It is ready for final posting.`,
      };
    }

    const finalDocNum = String(
      result.invoice?.DocNum ?? result.invoice?.DocEntry ?? "",
    );
    if (!finalDocNum) {
      throw new ApiError(
        "The final SAP Test AP invoice number could not be confirmed.",
        502,
      );
    }
    const saved = await db
      .from("sap_postings")
      .update({
        status: "posted",
        sap_docnum: finalDocNum,
        response: {
          ...previousResponse,
          DraftDocEntry: draftDocEntry,
          FinalDocEntry: result.invoice?.DocEntry,
          FinalDocNum: result.invoice?.DocNum,
          FinalizeResponse: result.serviceResult,
        },
        error: null,
      })
      .eq("case_id", uuid(id))
      .eq("owner_user_id", user)
      .eq("kind", "AP")
      .eq("sap_env", "test");
    dbCheck(saved.error);

    const event = await db.from("case_review_events").insert({
      case_id: id,
      owner_user_id: user,
      action: result.alreadyPosted
        ? "sap_ap_invoice_linked"
        : "sap_ap_invoice_posted",
      details: {
        sapEnv: "test",
        draftDocEntry,
        finalDocEntry: result.invoice?.DocEntry,
        finalDocNum: result.invoice?.DocNum,
        invoiceNumber: expectedInvoiceNumber,
      },
    });
    dbCheck(event.error);

    return {
      ok: true,
      posted: true,
      alreadyPosted: result.alreadyPosted,
      docEntry: result.invoice?.DocEntry,
      docNum: finalDocNum,
      message: result.alreadyPosted
        ? `SAP Test AP Invoice ${finalDocNum} was already posted and is now linked to this case.`
        : `SAP Test AP Invoice ${finalDocNum} was posted successfully from Draft ${draftDocEntry}.`,
    };
  });
}

export async function GET(request: Request, context: Context) {
  return handle(request, context, false);
}

export async function POST(request: Request, context: Context) {
  return handle(request, context, true);
}
