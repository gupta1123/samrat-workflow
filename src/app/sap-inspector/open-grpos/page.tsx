"use client";

import { AppShell } from "@/components/dashboard/AppShell";
import { useState } from "react";
import { FtpInvoiceInbox } from "@/components/sap/FtpInvoiceInbox";
import { OpenGrpoList } from "@/components/sap/OpenGrpoList";
import Link from "next/link";
import { FolderPlus } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function OpenGrpoInspectorPage() {
  const [view, setView] = useState<"receipts" | "invoices">("receipts");
  return (
    <AppShell defaultSidebarCollapsed>
      <main className="min-h-full bg-[#f7f4ef] px-4 py-6 text-[#17130f] sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1500px]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">Unbilled Receipts</h1>
              <p className="mt-1 text-sm text-[#71675e]">
                {view === "receipts"
                  ? "Goods received with quantities still left to bill."
                  : "Invoice PDFs from the client’s FTP inbox."}
              </p>
            </div>
            <Button
              asChild
              className="bg-[#6b3d20] text-white hover:bg-[#543019]"
            >
              <Link href="/workspace">
                <FolderPlus className="h-4 w-4" />
                Add Folder
              </Link>
            </Button>
          </div>
          <div
            className="mt-6 flex flex-wrap gap-2 border-b border-[#ded5c9] pb-3"
            aria-label="Unbilled receipts views"
          >
            <Button
              variant={view === "receipts" ? "default" : "outline"}
              aria-pressed={view === "receipts"}
              onClick={() => setView("receipts")}
            >
              SAP Receipts
            </Button>
            <Button
              variant={view === "invoices" ? "default" : "outline"}
              aria-pressed={view === "invoices"}
              onClick={() => setView("invoices")}
            >
              Non-Material Invoices
            </Button>
          </div>
          {view === "receipts" ? <OpenGrpoList /> : <FtpInvoiceInbox />}
        </div>
      </main>
    </AppShell>
  );
}
