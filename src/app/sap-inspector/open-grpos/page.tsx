"use client";

import { AppShell } from "@/components/dashboard/AppShell";
import { OpenGrpoList } from "@/components/sap/OpenGrpoList";

export default function OpenGrpoInspectorPage() {
  return (
    <AppShell defaultSidebarCollapsed>
      <main className="min-h-full bg-[#f7f4ef] px-4 py-6 text-[#17130f] sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1500px]">
          <h1 className="text-2xl font-semibold">Unbilled Receipts</h1>
          <p className="mt-1 text-sm text-[#71675e]">
            Goods received with quantities still left to bill.
          </p>
          <OpenGrpoList />
        </div>
      </main>
    </AppShell>
  );
}
