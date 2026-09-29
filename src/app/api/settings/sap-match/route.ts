import { ApiError, jsonBody, withUser } from "@/server/api/helpers";
import { parseRulesInput } from "@/server/sap/match-mapping";
import { loadMatchRules, saveMatchRules } from "@/server/sap/match-data";

export async function GET(request: Request) {
  return withUser(request, async (db) => ({ rules: await loadMatchRules(db) }));
}

export async function PUT(request: Request) {
  return withUser(request, async (db, user) => {
    let rules;
    try {
      rules = parseRulesInput(await jsonBody(request));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(error instanceof Error ? error.message : "Invalid matching rules.");
    }
    await saveMatchRules(db, rules);
    const event = await db.from("case_review_events").insert({
      case_id: "00000000-0000-0000-0000-000000000000",
      owner_user_id: user,
      action: "sap_match_rules_saved",
      details: { rules },
    });
    if (event.error) console.error("Could not record rules event:", event.error.message);
    return { rules };
  });
}
