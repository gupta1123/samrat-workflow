import { NextResponse } from "next/server";

/** Fail closed before authentication, database writes, or any SAP request. */
export function finalInvoicePostingDisabled() {
  return NextResponse.json(
    {
      ok: false,
      code: "SAP_DRAFT_ONLY",
      error:
        "This workflow ends when the A/P Invoice Draft is saved in SAP. Final A/P Invoice posting is disabled.",
    },
    { status: 410 },
  );
}
