import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    service: "samrat-workflow",
    status: "ok",
    checkedAt: new Date().toISOString(),
  });
}

