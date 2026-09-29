import {
  ApiError,
  dbCheck,
  jsonBody,
  ownedCase,
  uuid,
  withUser,
} from "@/server/api/helpers";
import { readSapEnvironment } from "@/server/sap/config";
import {
  computeCaseMatch,
  loadMatchState,
  saveItemMapping,
  saveMatchState,
} from "@/server/sap/match-data";
import { withTestServiceLayer } from "@/server/sap/service-layer";

type Context = { params: Promise<{ id: string }> };

const REVIEWABLE = ["completed", "accepted", "rejected"];
const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/;
const ALLOCATION_KEY = /^\d{1,12}:\d{1,6}$/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function postings(
  db: Parameters<Parameters<typeof withUser>[1]>[0],
  user: string,
  caseId: string,
) {
  const result = await db
    .from("sap_postings")
    .select("kind, status, sap_env, sap_docnum, error, created_at, updated_at")
    .eq("case_id", uuid(caseId))
    .eq("owner_user_id", user)
    .order("created_at");
  dbCheck(result.error);
  return result.data ?? [];
}

export async function GET(request: Request, context: Context) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    const row = await ownedCase(db, user, id);
    const sapEnv = readSapEnvironment();
    const savedPostings = await postings(db, user, id);
    const base = {
      sapEnv,
      caseStatus: row.status,
      postable: row.status === "accepted",
      postings: savedPostings,
    };
    if (!REVIEWABLE.includes(row.status)) {
      return { ...base, available: false, reason: "Analyze the case before matching it to SAP." };
    }
    if (sapEnv !== "test") {
      return {
        ...base,
        available: false,
        reason: "SAP matching is available only against the SAP Test company for now.",
      };
    }
    try {
      const match = await withTestServiceLayer((client) =>
        computeCaseMatch({ db, client, caseRow: row }),
      );
      return { ...base, ...match };
    } catch (error) {
      console.error("SAP match failed", {
        caseId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ...base,
        available: false,
        sapError:
          error instanceof Error ? error.message : "Could not read SAP for matching.",
        reason: "Could not read SAP. Nothing was changed.",
      };
    }
  });
}

export async function POST(request: Request, context: Context) {
  return withUser(request, async (db, user) => {
    const { id } = await context.params;
    const row = await ownedCase(db, user, id);
    if (!REVIEWABLE.includes(row.status)) {
      throw new ApiError("Analyze the case before matching it to SAP.", 409);
    }
    const body = record(await jsonBody(request));
    const action = body.action;

    const existing = (await postings(db, user, id)).find(
      (posting) =>
        posting.kind === "AP" &&
        posting.sap_env === "test" &&
        (posting.status === "prepared" || posting.status === "posted"),
    );
    if (existing && action !== "map-item") {
      throw new ApiError(
        "A SAP draft already exists for this case, so the match is locked. Discard the draft in SAP first.",
        409,
      );
    }

    const audit = async (name: string, details: Record<string, unknown>) => {
      const event = await db.from("case_review_events").insert({
        case_id: id,
        owner_user_id: user,
        action: name,
        details,
      });
      if (event.error) console.error("Could not record SAP match event:", event.error.message);
    };

    if (action === "decide" || action === "undo") {
      const checkId = typeof body.checkId === "string" ? body.checkId : "";
      if (!CHECK_ID.test(checkId)) throw new ApiError("Invalid check.");
      const state = await loadMatchState(db, id);
      if (action === "undo") {
        delete state.decisions[checkId];
        await saveMatchState(db, id, user, state);
        await audit("sap_match_decision_undone", { checkId });
        return { ok: true };
      }
      const choice = typeof body.choice === "string" ? body.choice.trim() : "";
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
      if (!choice || choice.length > 40) throw new ApiError("Invalid choice.");
      state.decisions[checkId] = {
        choice,
        ...(reason ? { reason } : {}),
        at: new Date().toISOString(),
      };
      await saveMatchState(db, id, user, state);
      await audit("sap_match_decision", { checkId, choice, reason: reason || null });
      return { ok: true };
    }

    if (action === "allocate" || action === "reset-allocation") {
      const lineIndex = Number(body.lineIndex);
      if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex > 200) {
        throw new ApiError("Invalid invoice line.");
      }
      const state = await loadMatchState(db, id);
      if (action === "reset-allocation") {
        delete state.allocations[String(lineIndex)];
        await saveMatchState(db, id, user, state);
        await audit("sap_match_allocation_reset", { lineIndex });
        return { ok: true };
      }
      const raw = record(body.allocations);
      const entries = Object.entries(raw);
      if (entries.length > 50) throw new ApiError("Too many receipts selected.");
      const allocations: Record<string, number> = {};
      for (const [key, value] of entries) {
        const quantity = Number(value);
        if (!ALLOCATION_KEY.test(key) || !Number.isFinite(quantity) || quantity < 0) {
          throw new ApiError("Invalid receipt selection.");
        }
        if (quantity > 0) allocations[key] = Math.round(quantity * 1000) / 1000;
      }
      state.allocations[String(lineIndex)] = allocations;
      await saveMatchState(db, id, user, state);
      await audit("sap_match_allocation_set", { lineIndex, allocations });
      return { ok: true };
    }

    if (action === "map-item") {
      const vendorCardCode = typeof body.vendorCardCode === "string" ? body.vendorCardCode.trim() : "";
      const mappingKey = typeof body.mappingKey === "string" ? body.mappingKey.trim() : "";
      const sapItemCode = typeof body.sapItemCode === "string" ? body.sapItemCode.trim() : "";
      if (!vendorCardCode || vendorCardCode.length > 50 || !mappingKey || mappingKey.length > 200 || !sapItemCode || sapItemCode.length > 50) {
        throw new ApiError("Choose the vendor material and the SAP item to link.");
      }
      if (readSapEnvironment() !== "test") {
        throw new ApiError("SAP matching is available only against the SAP Test company for now.", 409);
      }
      const found = await withTestServiceLayer((client) => client.listItemsByCodes([sapItemCode]));
      const item = found.find((entry) => entry.ItemCode === sapItemCode);
      if (!item) throw new ApiError("That item does not exist in SAP.", 409);
      await saveItemMapping(db, {
        vendorCardCode,
        vendorItemKey: mappingKey,
        sapItemCode,
        sapItemName: item.ItemName ?? null,
        userId: user,
      });
      await audit("sap_item_linked", { vendorCardCode, mappingKey, sapItemCode });
      return { ok: true };
    }

    throw new ApiError("Unknown action.");
  });
}
