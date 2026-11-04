"use client";

import Link from "next/link";
import { AppShell } from "@/components/dashboard/AppShell";
import { GrpoInspectorTab } from "@/components/sap/GrpoInspectorTab";
import { RecordDetails } from "@/components/sap/SapInspectorPage";

export default function OpenGrpoInspectorPage() {
  return (
    <AppShell defaultSidebarCollapsed>
      <main className="min-h-full bg-[#f7f4ef] px-4 py-6 text-[#17130f] sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1680px]">
          <Link
            href="/sap-inspector"
            className="text-sm text-[#6b3d20] underline"
          >
            Back to SAP Data Inspector
          </Link>
          <h1 className="mt-3 text-2xl font-semibold">Open GRPO Inspector</h1>
          <p className="mt-1 text-sm text-[#71675e]">
            Open, non-cancelled goods receipts from SAP Test. The list shows the
            remaining quantity SAP reports for each line. Expand a receipt to
            see its original quantities and linked purchase orders.
          </p>
          <GrpoInspectorTab
            openOnly
            renderDetails={(record) => <RecordDetails record={record} />}
          />
        </div>
      </main>
    </AppShell>
  );
}
