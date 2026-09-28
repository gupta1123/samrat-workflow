import { dbCheck, withUser } from "@/server/api/helpers";
export async function GET(request: Request) {
  return withUser(request, async (db, user) => {
    const { data, error } = await db.rpc("case_counts", { p_user: user });
    dbCheck(error);
    return data;
  });
}
