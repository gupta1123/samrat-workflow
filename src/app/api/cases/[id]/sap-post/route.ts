import { NextResponse } from "next/server";
import {
  dbCheck,
  jsonBody,
  ownedCase,
  uuid,
  withUser,
} from "@/server/api/helpers";
import { readStoredLineItems } from "@/server/line-items";
import { fetchSapOpenGRPOs, fetchSapOpenPOs } from "@/server/sap/client";
import {
  readSapCreateUrls,
  readSapEnvironment,
} from "@/server/sap/config";
import {
  classifySapCase,
  matchSapReference,
  type SapPostingKind,
} from "@/lib/sap-decision";
import {
  buildSapPayload,
  extractSapDocNum,
  type SapPacketLine,
} from "@/server/sap/posting";

type Context = { params: Promise<{ id: string }> };

function docNums(rows: Record<string, unknown>[]): Array<string | number> {
  const out: Array<string | number> = [];
  for (const row of rows) {
    const value = row.DocNum;
    if (typeof value === "string" || typeof value === "number") out.push(value);
  }
  return out;
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export async function POST(request: Request, context: Context) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    const requestBody = (await jsonBody(request).catch(() => ({}))) as {
      basePoDocNum?: unknown;
      baseGrpoDocNum?: unknown;
    };
    const basePoOverride =
      typeof requestBody.basePoDocNum === "string" &&
      requestBody.basePoDocNum.trim()
        ? requestBody.basePoDocNum.trim()
        : null;
    const baseGrpoOverride =
      typeof requestBody.baseGrpoDocNum === "string" &&
      requestBody.baseGrpoDocNum.trim()
        ? requestBody.baseGrpoDocNum.trim()
        : null;

    const row = await ownedCase(db, user, id);
    if (row.status !== "accepted") {
      return NextResponse.json(
        {
          error:
            "SAP posting is available only after the case is approved. Approve the case first.",
          caseStatus: row.status,
        },
        { status: 409 },
      );
    }

    const documentsResult = await db
      .from("packet_documents")
      .select("client_document_id, document_type, title, extracted_fields")
      .eq("case_id", id)
      .order("created_at");
    dbCheck(documentsResult.error);

    const documents = (documentsResult.data ?? []).map((d) => ({
      id: String(d.client_document_id ?? ""),
      documentType: String(d.document_type ?? ""),
      title: String(d.title ?? ""),
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
    if (classification.plan.length === 0) {
      return NextResponse.json(
        { error: classification.blockedReason, classification },
        { status: 409 },
      );
    }

    const sapEnv = readSapEnvironment();
    const createUrls = readSapCreateUrls();

    let matchedPoDocNum: string | null = null;
    let matchedGrpoDocNum: string | null = null;
    let openPOs: Record<string, unknown>[] = [];
    let openGRPOs: Record<string, unknown>[] = [];
    try {
      [openPOs, openGRPOs] = await Promise.all([
        fetchSapOpenPOs(sapEnv),
        fetchSapOpenGRPOs(sapEnv),
      ]);
      matchedPoDocNum = matchSapReference(
        classification.poNumber,
        docNums(openPOs),
      );
      matchedGrpoDocNum = matchSapReference(
        classification.poNumber,
        docNums(openGRPOs),
      );
    } catch {
      // Matching is advisory; posting payload still carries the case references.
    }

    const rowsForDocNum = (
      rows: Record<string, unknown>[],
      docNum: string | null,
    ) =>
      docNum === null
        ? []
        : rows.filter((r) => String(r.DocNum ?? "").trim() === docNum);

    const existingResult = await db
      .from("sap_postings")
      .select("kind, status")
      .eq("case_id", uuid(id))
      .eq("owner_user_id", user);
    dbCheck(existingResult.error);
    const alreadyPosted = new Set(
      (existingResult.data ?? [])
        .filter((entry) => entry.status === "posted")
        .map((entry) => String(entry.kind)),
    );
    const kindsToPost = classification.plan.filter(
      (kind) => !alreadyPosted.has(kind),
    );
    if (kindsToPost.length === 0) {
      return {
        ok: true,
        alreadyPosted: true,
        posted: [],
        skipped: classification.plan,
        message: "These documents were already posted to SAP for this case.",
      };
    }

    const packetLines: SapPacketLine[] = (
      documentsResult.data ?? []
    ).flatMap((d) =>
      readStoredLineItems(d.extracted_fields).map((item) => ({
        documentType: String(d.document_type ?? ""),
        description:
          typeof item.description === "string" ? item.description : undefined,
        hsnSac: typeof item.hsnSac === "string" ? item.hsnSac : undefined,
        quantity: item.quantity,
        unit: typeof item.unit === "string" ? item.unit : undefined,
        rate: item.rate,
        taxableAmount: item.taxableAmount,
        taxAmount: item.taxAmount,
      })),
    );

    const baseDocNumFor = (kind: SapPostingKind): string | null =>
      kind === "GRN"
        ? (basePoOverride ?? matchedPoDocNum)
        : (baseGrpoOverride ??
          matchedGrpoDocNum ??
          basePoOverride ??
          matchedPoDocNum);

    const payloadFor = (kind: SapPostingKind, createdGrnDocNum: string | null = null) => {
      const baseDocNum = baseDocNumFor(kind);
      const baseRows =
        kind === "GRN"
          ? rowsForDocNum(openPOs, baseDocNum)
          : rowsForDocNum(openGRPOs, baseDocNum);
      const payload = buildSapPayload({
        kind,
        sapEnv,
        caseId: id,
        caseSlug: row.display_name,
        poNumber: classification.poNumber,
        invoiceNumber: classification.invoiceNumber,
        baseDocNum,
        baseDocChosenBy: (
          kind === "GRN" ? basePoOverride : baseGrpoOverride
        )
          ? "reviewer"
          : "automatic",
        receiptEvidence: classification.receiptDocumentTypes,
        baseRows,
        packetLines,
        documents: documents.map((d) => ({
          type: d.documentType,
          title: d.title,
          fields: d.extractedFields,
        })),
        createdGrnDocNum,
      });
      return { kind, baseDocNum, payload };
    };

    // No SAP create endpoint is configured yet: the supplied OpenPO/OpenGRPO
    // URLs are GET-only reads (POST returns 405). Persist the prepared payload
    // so nothing is lost, and tell the caller exactly what to request.
    const missing = kindsToPost.filter(
      (kind) => !(kind === "GRN" ? createUrls.grn : createUrls.ap),
    );
    if (missing.length > 0) {
      for (const kind of kindsToPost) {
        const saved = await db.from("sap_postings").upsert(
          {
            case_id: uuid(id),
            owner_user_id: user,
            kind,
            status: "blocked",
            sap_env: sapEnv,
            payload: payloadFor(kind).payload,
            response: {},
            error:
              "SAP_CREATE_API_MISSING: ask the SAP team for POST create URLs for GRPO (GRN) and AP Invoice.",
          },
          { onConflict: "case_id,kind,sap_env" },
        );
        dbCheck(saved.error);
      }
      const event = await db.from("case_review_events").insert({
        case_id: id,
        owner_user_id: user,
        action: "sap_posting_blocked",
        details: {
          kinds: kindsToPost,
          reason: "SAP_CREATE_API_MISSING",
          sapEnv,
          poNumber: classification.poNumber,
          invoiceNumber: classification.invoiceNumber,
        },
      });
      dbCheck(event.error);
      return NextResponse.json(
        {
          ok: false,
          code: "SAP_CREATE_API_MISSING",
          kinds: kindsToPost,
          classification,
          payloads: kindsToPost.map((kind) => ({
            kind,
            ...payloadFor(kind).payload,
          })),
          message:
            "The SAP team supplied only OpenPO/OpenGRPO read URLs (GET-only; POST returns 405). " +
            "Share POST create URLs for GRPO (GRN) and AP Invoice and set SAP_CREATE_GRPO_URL / SAP_CREATE_AP_URL. " +
            "The prepared payloads above are saved on the case and ready to send.",
        },
        { status: 409 },
      );
    }

    // Create URLs are configured: post each kind in plan order (GRN then
    // AP). The AP payload carries the just-created GRN number so SAP can
    // link the invoice to the goods receipt in a single run.
    const { username, password } = await readSapCredentials(sapEnv);
    const results: Array<Record<string, unknown>> = [];
    let createdGrnDocNum: string | null = null;
    for (const kind of kindsToPost) {
      const url = kind === "GRN" ? createUrls.grn : createUrls.ap;
      const { baseDocNum, payload } = payloadFor(kind, createdGrnDocNum);
      const savePosting = async (
        status: "posted" | "failed",
        responseBody: unknown,
        sapDocnum: string | null,
        errorMessage: string | null,
      ) => {
        const saved = await db.from("sap_postings").upsert(
          {
            case_id: uuid(id),
            owner_user_id: user,
            kind,
            status,
            sap_env: sapEnv,
            sap_docnum: sapDocnum,
            payload,
            response:
              responseBody && typeof responseBody === "object"
                ? (responseBody as Record<string, unknown>)
                : { raw: String(responseBody ?? "").slice(0, 2000) },
            error: errorMessage,
          },
          { onConflict: "case_id,kind,sap_env" },
        );
        dbCheck(saved.error);
      };
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        let response: globalThis.Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: basicAuth(username, password),
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
        const responseText = await response.text().catch(() => "");
        const responseBody: unknown = (() => {
          try {
            return responseText ? JSON.parse(responseText) : {};
          } catch {
            return { raw: responseText.slice(0, 2000) };
          }
        })();
        if (!response.ok) {
          const detail =
            typeof responseBody === "object" && responseBody !== null
              ? JSON.stringify(responseBody).slice(0, 500)
              : responseText.slice(0, 500);
          throw new Error(
            `SAP responded with HTTP ${response.status}${detail ? `: ${detail}` : ""}.`,
          );
        }
        const sapDocnum = extractSapDocNum(responseBody);
        await savePosting("posted", responseBody, sapDocnum, null);
        if (kind === "GRN" && sapDocnum) createdGrnDocNum = sapDocnum;
        results.push({ kind, ok: true, baseDocNum, sapDocNum: sapDocnum, response: responseBody });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "SAP posting failed.";
        await savePosting("failed", {}, null, message);
        results.push({ kind, ok: false, baseDocNum, error: message });
      }
    }

    const event = await db.from("case_review_events").insert({
      case_id: id,
      owner_user_id: user,
      action: "sap_posting_attempted",
      details: { kinds: kindsToPost, sapEnv, results },
    });
    dbCheck(event.error);

    const failed = results.filter((entry) => !entry.ok);
    if (failed.length > 0) {
      return NextResponse.json(
        { ok: false, posted: results, message: "Some SAP postings failed. Retry after fixing the errors." },
        { status: 502 },
      );
    }
    return { ok: true, posted: results };
  });
}

async function readSapCredentials(env: "test" | "live") {
  const prefix = env === "live" ? "SAP_LIVE" : "SAP_TEST";
  const username = (process.env[`${prefix}_USERNAME`] ?? "").trim();
  const password = (process.env[`${prefix}_PASSWORD`] ?? "").trim();
  if (!username || !password) throw new Error(`Missing ${prefix}_USERNAME.`);
  return { username, password };
}
