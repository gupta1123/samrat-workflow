"use client";

import Link from "next/link";
import { AppShell } from "@/components/dashboard/AppShell";
import { OpenGrpoList } from "@/components/sap/OpenGrpoList";

export default function OpenGrpoInspectorPage() {
  return (
    <AppShell defaultSidebarCollapsed>
      <main className="min-h-full bg-[#f7f4ef] px-4 py-6 text-[#17130f] sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <Link
            href="/sap-inspector"
            className="text-sm text-[#6b3d20] underline"
          >
            Back to SAP data
          </Link>
          <h1 className="mt-3 text-2xl font-semibold">Open GRPOs</h1>
          <p className="mt-1 text-sm text-[#71675e]">
            Open goods receipts from SAP Test and their remaining quantities.
          </p>
          <OpenGrpoList />
        </div>
      </main>
    </AppShell>
  );
}
