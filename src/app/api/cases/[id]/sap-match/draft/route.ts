import { NextResponse } from "next/server";

import {
  ApiError,
  dbCheck,
  jsonBody,
  ownedCase,
  uuid,
  withUser,
} from "@/server/api/helpers";
import { readSapEnvironment } from "@/server/sap/config";
import { fetchSapOpenGRPOs, fetchSapOpenPOs } from "@/server/sap/client";
import { openDocumentDraftFields } from "@/server/sap/open-document-draft-fields";
import { authoritativeOutlierDocumentIds } from "@/server/sap/match-data";
import {
  buildDraftHeaderFields,
  DRAFT_FIELD_NAMES,
} from "@/server/sap/draft-fields";
import type { DraftFieldChoices } from "@/lib/sap-draft-fields";
import { UNRELATED_DOCUMENT_FIELD } from "@/lib/unrelated-document";
import { saveSapMatch } from "@/lib/sap-posted-details";
import { sapDocumentSnapshot } from "@/lib/sap-posting-preview";
import { enqueueSapMatch, readSapMatchJob } from "@/server/sap/match-job";
import {
  buildMatchedDraftPayload,
  createMatchedDraft,
  MatchDraftError,
} from "@/server/sap/match-draft";
import {
  withTestServiceLayer,
  type SapMatchDocument,
} from "@/server/sap/service-layer";

type Context = { params: Promise<{ id: string }> };

async function loadHeader(
  db: Parameters<Parameters<typeof withUser>[1]>[0],
  client: Parameters<Parameters<typeof withTestServiceLayer>[0]>[0],
  caseId: string,
  match: Extract<
    NonNullable<Awaited<ReturnType<typeof readSapMatchJob>>>["result"],
    { available: true }
  >,
  choices: DraftFieldChoices = {},
) {
  const [documents, mismatches, metadata] = await Promise.all([
    db
      .from("packet_documents")
      .select("client_document_id, document_type, extracted_fields")
      .eq("case_id", caseId)
      .order("created_at"),
    db
      .from("packet_mismatches")
      .select("field_name, values_json, resolution_status")
      .eq("case_id", caseId)
      .eq("field_name", UNRELATED_DOCUMENT_FIELD),
    client.getUserFieldsByNames("OPCH", DRAFT_FIELD_NAMES),
  ]);
  dbCheck(documents.error);
  dbCheck(mismatches.error);
  const excluded = authoritativeOutlierDocumentIds(mismatches.data ?? []);
  try {
    return buildDraftHeaderFields({
      invoice: match.invoice,
      documents: (documents.data ?? []).filter(
        (doc) => !excluded.has(doc.client_document_id),
      ),
      metadata,
      choices,
      service: match.result.method === "2-way",
    });
  } catch (error) {
    throw new ApiError(
      error instanceof Error
        ? error.message
        : "Could not prepare draft fields.",
      409,
    );
  }
}

/** Read-only preview; available before approval so the user can review PDF gaps. */
export async function GET(request: Request, context: Context) {
  return withUser(request, async (db, user) => {
    if (readSapEnvironment() !== "test")
      throw new ApiError("Draft creation is enabled only for SAP Test.", 409);
    const { id } = await context.params;
    await ownedCase(db, user, id);
    const job = await readSapMatchJob(db, user, id);
    if (
      job?.status !== "succeeded" ||
      !job.result?.available ||
      !job.result.result.payload
    ) {
      throw new ApiError(
        "Wait for the SAP match to finish before reviewing draft fields.",
        409,
      );
    }
    const match = job.result;
    const header = await withTestServiceLayer((client) =>
      loadHeader(db, client, id, match),
    );
    return { ok: true, preview: header.preview };
  });
}

function freightExpenseCode(): number | null {
  const value = Number((process.env.SAP_FREIGHT_EXPENSE_CODE ?? "").trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

// Creates the SAP Test A/P Invoice DRAFT from the current match. Nothing is
// posted: the existing final-post route re-checks the draft before that.
export async function POST(request: Request, context: Context) {
  return withUser(request, async (db, user) => {
    if (readSapEnvironment() !== "test") {
      throw new ApiError(
        "AP Invoice Draft creation is enabled only for the SAP Test company.",
        409,
      );
    }
    const { id } = await context.params;
    const row = await ownedCase(db, user, id);
    if (row.status !== "accepted") {
      throw new ApiError("Approve the case before creating an SAP draft.", 409);
    }
    const body = (await jsonBody(request)) as DraftFieldChoices;
    const choices: DraftFieldChoices = {
      materialForm:
        typeof body?.materialForm === "string"
          ? body.materialForm.trim()
          : undefined,
      transporter:
        typeof body?.transporter === "string"
          ? body.transporter.trim()
          : undefined,
    };

    const existing = await db
      .from("sap_postings")
      .select("status, sap_docnum")
      .eq("case_id", uuid(id))
      .eq("owner_user_id", user)
      .eq("kind", "AP")
      .eq("sap_env", "test")
      .maybeSingle();
    dbCheck(existing.error);
    if (
      existing.data?.sap_docnum &&
      (existing.data.status === "prepared" || existing.data.status === "posted")
    ) {
      return {
        ok: true,
        alreadyCreated: true,
        draft: existing.data.status === "prepared",
        docEntry: existing.data.sap_docnum,
        message:
          existing.data.status === "prepared"
            ? `SAP Test AP Invoice Draft ${existing.data.sap_docnum} already exists for this case.`
            : "An AP invoice was already posted for this case; no draft was created.",
      };
    }

    let matchJob = await readSapMatchJob(db, user, id);
    if (
      !matchJob ||
      matchJob.status === "failed" ||
      matchJob.status === "cancelled"
    ) {
      matchJob = await enqueueSapMatch(db, user, id, true);
    }
    if (matchJob.status !== "succeeded" || !matchJob.result) {
      throw new ApiError(
        "The latest SAP re-check is still running. Wait for the SAP tab to finish, then create the draft.",
        409,
      );
    }
    const cachedMatch = matchJob.result;

    let outcome;
    try {
      outcome = await withTestServiceLayer(async (client) => {
        const match = cachedMatch;
        if (!match.available) throw new ApiError(match.reason, 409);
        const plan = match.result.payload;
        if (match.result.status !== "ready" || !plan) {
          throw new ApiError(
            "This invoice is not ready. Resolve every open item in the match before creating the draft.",
            409,
          );
        }
        const header = await loadHeader(db, client, id, match, choices);
        if (
          !header.preview.materialForm.selectedValue ||
          !header.preview.transporter.selectedValue
        ) {
          throw new ApiError(
            "Select Material Form and Transporter from the SAP choices before creating a draft.",
            409,
          );
        }
        if (
          match.result.method !== "2-way" &&
          match.invoice.lines.some((line) => line.rate === null)
        ) {
          throw new ApiError(
            "Every goods invoice line needs a unit price from the PDF before creating a draft.",
            409,
          );
        }

        // The background result may be a few seconds old. Duplicate status and
        // every selected base document are re-read immediately before the write.
        const posted = await client.findInvoiceByReference(
          plan.cardCode,
          plan.numAtCard,
        );
        if (posted) {
          throw new ApiError(
            `This vendor invoice is already in SAP as A/P invoice ${posted.DocNum ?? posted.DocEntry ?? "?"}.`,
            409,
          );
        }
        const otherDraft = await client.findDraftByVendorReference(
          plan.cardCode,
          plan.numAtCard,
        );
        if (
          otherDraft &&
          !String(otherDraft.Comments ?? "").startsWith(`Samrat case ${id}`)
        ) {
          throw new ApiError(
            `This vendor invoice is already in SAP as draft ${otherDraft.DocNum ?? otherDraft.DocEntry ?? "?"}.`,
            409,
          );
        }

        // Re-read every base document right before writing, never trust the earlier read.
        const bases = new Map<string, SapMatchDocument>();
        for (const base of match.result.baseDocuments) {
          const document = (base.kind === "GRPO"
            ? await client.getGrpo(base.docEntry)
            : await client.getPurchaseOrder(
                base.docEntry,
              )) as unknown as SapMatchDocument;
          if (
            document.DocEntry !== base.docEntry ||
            document.DocNum !== base.docNum ||
            document.CardCode !== plan.cardCode ||
            document.Cancelled !== "tNO" ||
            document.DocumentStatus !== "bost_Open"
          ) {
            throw new ApiError(
              `SAP ${base.kind === "GRPO" ? "receipt" : "purchase order"} ${base.docNum} changed or is no longer open. Refresh the match.`,
              409,
            );
          }
          bases.set(
            `${base.kind === "GRPO" ? 20 : 22}:${base.docEntry}`,
            document,
          );
        }

        const { payload, currency } = buildMatchedDraftPayload({
          caseId: id,
          plan,
          bases,
          freightExpenseCode: freightExpenseCode(),
          invoiceRates: match.invoice.lines.map((line) => line.rate),
        });
        Object.assign(payload, header.values);
        const [grpos, pos] = await Promise.all([
          plan.lines.some((line) => line.baseType === 20)
            ? fetchSapOpenGRPOs("test", true)
            : Promise.resolve([]),
          plan.lines.some((line) => line.baseType === 22)
            ? fetchSapOpenPOs("test", true)
            : Promise.resolve([]),
        ]);
        Object.assign(payload, openDocumentDraftFields(plan, { grpos, pos }));
        if (match.invoice.currency && match.invoice.currency !== currency) {
          throw new ApiError(
            "The vendor invoice currency differs from the selected SAP documents.",
            409,
          );
        }

        const first = [...bases.values()][0] as SapMatchDocument & {
          Series?: number;
          BPL_IDAssignedToInvoice?: number | null;
        };
        const created = await createMatchedDraft(client, {
          payload,
          currency,
          postingDate: plan.docDate,
          taxDate: plan.taxDate,
          baseDocument: first,
        });
        return { match, plan, created, header };
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof MatchDraftError)
        throw new ApiError(error.message, 409);
      console.error("SAP Test matched AP draft creation failed", {
        caseId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "SAP Test draft creation failed.",
        },
        { status: 502 },
      );
    }

    const { match, plan, created, header } = outcome;
    const docEntry = created.created.DocEntry;
    if (!Number.isInteger(docEntry) || !docEntry) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "SAP may have created the draft but did not return its entry number. Check SAP before retrying.",
        },
        { status: 502 },
      );
    }

    const first = match.result.baseDocuments[0];
    const saved = await db.from("sap_postings").upsert(
      {
        case_id: uuid(id),
        owner_user_id: user,
        kind: "AP",
        status: "prepared",
        sap_env: "test",
        sap_docnum: String(docEntry),
        payload: {
          documentType: "APInvoiceDraft",
          caseId: id,
          matched: true,
          matchSnapshot: saveSapMatch(match, created.postingDate),
          method: match.result.method,
          baseKind: match.result.baseDocuments.some((doc) => doc.kind === "PO")
            ? "PO"
            : "GRPO",
          baseDocNum: first.docNum,
          baseDocEntry: first.docEntry,
          baseDocuments: match.result.baseDocuments,
          invoiceNumber: plan.numAtCard,
          postingDate: created.postingDate,
          requestedPostingDate: plan.docDate,
          invoiceDate: plan.taxDate,
          usedHistoricalTestPostingDate: created.usedHistoricalPostingDate,
          numberingSeries: created.series,
          lines: plan.lines,
          freightExpense: plan.freightExpense,
          freightExcluded: plan.freightExcluded,
          draftHeaderFields: header.values,
          draftHeaderEvidence: header.preview.fields,
          submittedPayload: created.submittedPayload,
        },
        response: {
          DocEntry: docEntry,
          DocNum: created.created.DocNum,
          CardCode: created.created.CardCode ?? plan.cardCode,
          SapDocumentSnapshot: sapDocumentSnapshot(created.created),
        },
        error: null,
      },
      { onConflict: "case_id,kind,sap_env" },
    );
    dbCheck(saved.error);
    const event = await db.from("case_review_events").insert({
      case_id: id,
      owner_user_id: user,
      action: "sap_ap_draft_created",
      details: {
        sapEnv: "test",
        docEntry,
        matched: true,
        baseDocuments: match.result.baseDocuments,
        decisions: match.state.decisions,
        allocations: match.state.allocations,
        draftHeaderFields: header.values,
        draftHeaderEvidence: header.preview.fields,
      },
    });
    if (event.error)
      console.error("Could not record SAP draft event:", event.error.message);

    return {
      ok: true,
      draft: true,
      docEntry,
      docNum: created.created.DocNum,
      postingDate: created.postingDate,
      invoiceDate: plan.taxDate,
      usedHistoricalTestPostingDate: created.usedHistoricalPostingDate,
      message: created.usedHistoricalPostingDate
        ? `SAP Test AP Invoice Draft ${docEntry} created with posting date ${created.postingDate}. The vendor invoice date ${plan.taxDate} was kept; SAP Test had no reporting rate for it. No invoice was posted.`
        : `SAP Test AP Invoice Draft ${docEntry} created. No invoice was posted.`,
    };
  });
}
