import { NextResponse } from "next/server";

import {
  ApiError,
  dbCheck,
  ownedCase,
  uuid,
  withUser,
} from "@/server/api/helpers";
import { readSapEnvironment } from "@/server/sap/config";
import { saveSapMatch } from "@/lib/sap-posted-details";
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

function freightExpenseCode(): number | null {
  const value = Number((process.env.SAP_FREIGHT_EXPENSE_CODE ?? "").trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

// Creates the SAP Test A/P Invoice DRAFT from the current match. Nothing is
// posted: the existing final-post route re-checks the draft before that.
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

    const existing = await db
      .from("sap_postings")
      .select("status, sap_docnum")
      .eq("case_id", uuid(id))
      .eq("owner_user_id", user)
      .eq("kind", "AP")
      .eq("sap_env", "test")
      .maybeSingle();
    dbCheck(existing.error);
    if (existing.data?.sap_docnum && (existing.data.status === "prepared" || existing.data.status === "posted")) {
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
    if (!matchJob || matchJob.status === "failed" || matchJob.status === "cancelled") {
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

        // The background result may be a few seconds old. Duplicate status and
        // every selected base document are re-read immediately before the write.
        const posted = await client.findInvoiceByReference(plan.cardCode, plan.numAtCard);
        if (posted) {
          throw new ApiError(
            `This vendor invoice is already in SAP as A/P invoice ${posted.DocNum ?? posted.DocEntry ?? "?"}.`,
            409,
          );
        }
        const otherDraft = await client.findDraftByVendorReference(plan.cardCode, plan.numAtCard);
        if (otherDraft && !String(otherDraft.Comments ?? "").startsWith(`Samrat case ${id}`)) {
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
            : await client.getPurchaseOrder(base.docEntry)) as unknown as SapMatchDocument;
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
          bases.set(`${base.kind === "GRPO" ? 20 : 22}:${base.docEntry}`, document);
        }

        const { payload, currency } = buildMatchedDraftPayload({
          caseId: id,
          plan,
          bases,
          freightExpenseCode: freightExpenseCode(),
        });
        if (match.invoice.currency && match.invoice.currency !== currency) {
          throw new ApiError("The vendor invoice currency differs from the selected SAP documents.", 409);
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
        return { match, plan, created };
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof MatchDraftError) throw new ApiError(error.message, 409);
      console.error("SAP Test matched AP draft creation failed", {
        caseId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : "SAP Test draft creation failed.",
        },
        { status: 502 },
      );
    }

    const { match, plan, created } = outcome;
    const docEntry = created.created.DocEntry;
    if (!Number.isInteger(docEntry) || !docEntry) {
      return NextResponse.json(
        {
          ok: false,
          error: "SAP may have created the draft but did not return its entry number. Check SAP before retrying.",
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
          baseKind: match.result.baseDocuments.some((doc) => doc.kind === "PO") ? "PO" : "GRPO",
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
        },
        response: {
          DocEntry: docEntry,
          DocNum: created.created.DocNum,
          CardCode: created.created.CardCode ?? plan.cardCode,
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
      },
    });
    if (event.error) console.error("Could not record SAP draft event:", event.error.message);

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
