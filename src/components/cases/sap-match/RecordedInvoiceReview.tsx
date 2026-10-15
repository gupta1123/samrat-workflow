"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { matchTimestamp } from "@/lib/sap-match/evidence";
import type {
  MatchCheck,
  MatchInvoice,
  MatchResult,
} from "@/lib/sap-match/types";
import { CheckBlock } from "./CheckBlock";
import { SupplierEvidence } from "./MatchingEvidence";
import { qty } from "./format";

const money = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
function amount(value: number | null, currency: string | null) {
  return value === null
    ? "—"
    : `${currency ?? ""} ${money.format(value)}`.trim();
}

/** Independent invoice and SAP lists: their row counts/grouping can differ.
 * There is deliberately no per-product match claim or item-link action here.
 */
export function RecordedInvoiceReview({
  invoice,
  vendor,
  result,
  env,
  busy,
  error,
  onRefresh,
  onChoose,
  onUndo,
}: {
  invoice: MatchInvoice;
  vendor: { cardCode: string; cardName: string } | null;
  result: MatchResult;
  env: string;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  onChoose: (check: MatchCheck, choice: string, reason: string) => void;
  onUndo: (check: MatchCheck) => void;
}) {
  const recorded = result.existingInvoice!;
  const evidence = recorded.evidence;
  const duplicate = result.checks.find((check) => check.id === "dup");
  const closed = result.status === "closed";
  return (
    <div className="space-y-4 px-4 py-3">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[16px] font-semibold text-[#111827]">
            {closed ? "Closed as duplicate" : "Already recorded in SAP"}
          </h2>
          <div className="flex items-center gap-3 text-[10px] text-[#8a7f72]">
            <span className="rounded-full bg-[#fdf1dc] px-2 py-1 font-semibold uppercase text-[#8a5207]">
              SAP {env}
            </span>
            <span>{matchTimestamp(result.checkedAt)}</span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-[11px]"
              disabled={busy}
              onClick={onRefresh}
            >
              <RefreshCw className="h-3 w-3" /> Re-check
            </Button>
          </div>
        </div>
        <p className="text-[12px] leading-5 text-[#3d3530]">
          Supplier invoice <b>{invoice.invoiceNumber}</b> already exists as{" "}
          <b>A/P Invoice {recorded.docNum}</b>. No new draft is needed.
        </p>
        <details className="text-[11px] text-[#6b5d50]">
          <summary className="cursor-pointer font-medium">
            Supplier identification
          </summary>
          <div className="mt-2">
            <SupplierEvidence
              invoice={invoice}
              vendor={vendor}
              result={result}
            />
          </div>
        </details>
      </header>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-[11px] text-[#b91c1c]"
        >
          {error}
        </p>
      ) : null}
      {duplicate ? (
        <CheckBlock
          check={duplicate}
          locked={false}
          busy={busy}
          onChoose={(choice, reason) => onChoose(duplicate, choice, reason)}
          onUndo={() => onUndo(duplicate)}
        />
      ) : null}

      <section className="overflow-hidden rounded-xl border border-[#e0d8cc] bg-white">
        <div className="space-y-1 border-b border-[#ede7de] px-4 py-3">
          <h3 className="text-[13px] font-semibold text-[#111827]">
            How this invoice was recorded
          </h3>
          <p className="text-[11px] leading-5 text-[#6b5d50]">
            Historical evidence only. SAP may group products into accounting
            lines. These lists do not establish individual product matches, and
            no item links have been created from this history.
          </p>
        </div>
        <div className="grid divide-y divide-[#ede7de] lg:grid-cols-2 lg:divide-x lg:divide-y-0">
          <div className="min-w-0 p-4">
            <h4 className="text-[12px] font-semibold text-[#111827]">
              From the invoice
            </h4>
            <p className="mt-1 text-[11px] text-[#8a7f72]">
              {invoice.lines.length} product / service lines
            </p>
            <ol className="mt-3 divide-y divide-[#ede7de]">
              {invoice.lines.map((line) => (
                <li key={line.index} className="space-y-1 py-3 first:pt-0">
                  <p className="break-words text-[12px] font-medium text-[#3d3530]">
                    {line.description ?? "Description not recorded"}
                  </p>
                  <p className="break-words text-[11px] text-[#6b5d50]">
                    Code:{" "}
                    <span className="font-mono">
                      {line.vendorItemCode ?? "Not printed / extracted"}
                    </span>
                  </p>
                  <p className="text-[11px] text-[#6b5d50]">
                    Quantity: {qty(line.quantity)} {line.unit ?? ""} · Before
                    tax: {amount(line.amount, invoice.currency)}
                  </p>
                </li>
              ))}
            </ol>
            {invoice.source?.fileName ? (
              <p className="mt-3 break-words text-[10px] text-[#8a7f72]">
                Source: {invoice.source.fileName}
              </p>
            ) : null}
          </div>
          <div className="min-w-0 p-4">
            <h4 className="text-[12px] font-semibold text-[#111827]">
              From SAP — recorded accounting lines
            </h4>
            <p className="mt-1 text-[11px] text-[#8a7f72]">
              A/P Invoice {recorded.docNum}
              {evidence ? ` · ${evidence.lines.length} SAP lines` : ""}
            </p>
            {evidence?.lines.length ? (
              <>
                <ol className="mt-3 divide-y divide-[#ede7de]">
                  {evidence.lines.map((line, index) => (
                    <li
                      key={`${line.lineNum}-${index}`}
                      className="space-y-1 py-3 first:pt-0"
                    >
                      <p className="break-words text-[12px] font-medium text-[#3d3530]">
                        {line.description ?? "Description not recorded"}
                      </p>
                      <p className="break-words text-[11px] text-[#6b5d50]">
                        Code:{" "}
                        <span className="font-mono">
                          {line.itemCode ?? "No item code — account-based line"}
                        </span>
                      </p>
                      <p className="text-[11px] text-[#6b5d50]">
                        Quantity: {qty(line.quantity)} · Before tax:{" "}
                        {amount(line.lineTotal, evidence.currency)}
                      </p>
                      {line.accountCode ? (
                        <p className="text-[10px] text-[#8a7f72]">
                          SAP account: {line.accountCode}
                        </p>
                      ) : null}
                      {line.lineNum !== null ? (
                        <p className="text-[10px] text-[#8a7f72]">
                          SAP line: {line.lineNum}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ol>
                <p className="mt-3 text-[11px] text-[#6b5d50]">
                  SAP document total:{" "}
                  {amount(evidence.total, evidence.currency)}
                </p>
              </>
            ) : (
              <p className="mt-3 rounded-lg bg-[#f8f5ef] p-3 text-[11px] leading-5 text-[#6b5d50]">
                SAP confirms this invoice already exists, but its item details
                are unavailable. Re-check to try again. Duplicate protection
                remains active.
              </p>
            )}
          </div>
        </div>
      </section>
      <p className="text-[11px] leading-5 text-[#6b5d50]">
        Nothing new will be sent to SAP. Product-by-product links are not
        required to close an already-recorded invoice.
      </p>
    </div>
  );
}
