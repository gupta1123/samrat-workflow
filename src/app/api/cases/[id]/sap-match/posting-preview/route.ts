import {
  ApiError,
  dbCheck,
  ownedCase,
  uuid,
  withUser,
} from "@/server/api/helpers";
import { readSapEnvironment } from "@/server/sap/config";
import { withTestServiceLayer } from "@/server/sap/service-layer";
import { postedSapDetails } from "@/lib/sap-posted-details";
import {
  assertSapPostingIdentity,
  object,
  sapDocumentSnapshot,
} from "@/lib/sap-posting-preview";

/** Read-only SAP GET. Never use the final-post route to render a preview. */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    await ownedCase(db, user, id);
    if (readSapEnvironment() !== "test")
      throw new ApiError("SAP preview is available for SAP Test.", 409);
    const result = await db
      .from("sap_postings")
      .select("status, sap_docnum, payload, response, updated_at")
      .eq("case_id", uuid(id))
      .eq("owner_user_id", user)
      .eq("kind", "AP")
      .eq("sap_env", "test")
      .maybeSingle();
    dbCheck(result.error);
    const posting = result.data;
    if (!posting || !["prepared", "posted"].includes(posting.status))
      throw new ApiError("No saved SAP document is available.", 409);
    const details = postedSapDetails(posting);
    const draft = posting.status === "prepared";
    const entry = Number(
      draft ? posting.sap_docnum : object(posting.response).FinalDocEntry,
    );
    if (
      !Number.isInteger(entry) ||
      entry <= 0 ||
      !details.vendorCode ||
      !details.invoiceNumber
    )
      throw new ApiError(
        "This older record has no complete SAP document identity.",
        409,
      );
    try {
      const document = await withTestServiceLayer((client) =>
        draft ? client.getDraft(entry) : client.getPurchaseInvoice(entry),
      );
      assertSapPostingIdentity(document, {
        entry,
        vendor: details.vendorCode,
        invoice: details.invoiceNumber,
        draft,
      });
      return { ok: true, snapshot: sapDocumentSnapshot(document) };
    } catch (error) {
      throw new ApiError(
        error instanceof Error
          ? error.message
          : "Could not read the saved SAP document.",
        502,
      );
    }
  });
}
