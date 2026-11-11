import { readSapEnvironment } from "@/server/sap/config";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    service: "samrat-workflow",
    status: "ok",
    sapEnvironment: readSapEnvironment(),
    checkedAt: new Date().toISOString(),
  });
}
