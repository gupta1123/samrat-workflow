"use client";

import { useEffect, useState } from "react";
import { Content as DialogContent } from "@radix-ui/react-dialog";
import { Check, ChevronRight, Loader2, Search, X } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import type { LineResult } from "@/lib/sap-match/types";
import type {
  SupplierOrder,
  SupplierOrdersResponse,
} from "@/lib/sap-match/supplier-orders";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatDate, inr, qty } from "./format";

function OrderCard({
  order,
  line,
}: {
  order: SupplierOrder;
  line: LineResult;
}) {
  const selected = order.selectedFor.includes(line.index);
  return (
    <li
      className={`rounded-md border px-3 py-2 ${selected ? "border-[#8bb59b] bg-[#f3f9f5]" : "border-[#e0d8cc] bg-white"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-1 text-[11px]">
        <h4 className="font-semibold text-[#111827]">
          PO {order.number ?? "Number unavailable"}
        </h4>
        {selected ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-[#dfefe4] px-1.5 py-0.5 text-[9px] font-medium text-[#24583e]">
            <Check className="h-2.5 w-2.5" />
            Used for this match
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 text-[10px] leading-4 text-[#6b5d50]">
        {[
          selected ? order.source : null,
          formatDate(order.date),
          order.status,
          order.reference ? `Ref. ${order.reference}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {order.lines.length ? (
        <table className="mt-1.5 w-full table-fixed text-left text-[10px] leading-4">
          <thead className="text-[#6b5d50]">
            <tr>
              <th className="w-[40%] font-normal">Item</th>
              <th className="w-[20%] text-right font-normal">Ordered</th>
              <th className="w-[20%] text-right font-normal">Open qty.</th>
              <th className="w-[20%] text-right font-normal">Unit price</th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((item, index) => (
              <tr
                key={`${item.number ?? index}:${item.item}`}
                className={`border-t border-[#e0d8cc] align-top ${item.item === line.itemCode ? "font-medium text-[#111827]" : "text-[#6b5d50]"}`}
              >
                <td className="break-words py-1 pr-1">
                  <span title={item.description ?? undefined}>
                    {item.item ?? item.description ?? "—"}
                  </span>
                </td>
                <td className="py-1 text-right tabular-nums">
                  {item.quantity == null ? "—" : qty(item.quantity)}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {item.openQuantity == null ? "—" : qty(item.openQuantity)}
                </td>
                <td className="break-words py-1 text-right tabular-nums">
                  {item.price == null
                    ? "—"
                    : order.currency === "INR"
                      ? inr(item.price)
                      : `${qty(item.price)}${order.currency ? ` ${order.currency}` : ""}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-1 text-[10px] text-[#6b5d50]">
          Item lines unavailable in this response.
        </p>
      )}
    </li>
  );
}

function OrderList({ caseId, line }: { caseId: string; line: LineResult }) {
  const [data, setData] = useState<SupplierOrdersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState("");
  useEffect(() => {
    let active = true;
    setError(null);
    setData(null);
    void (async () => {
      try {
        const response = await apiFetch(
          `/api/cases/${encodeURIComponent(caseId)}/sap-match/purchase-orders`,
          { cache: "no-store" },
        );
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            typeof body.error === "string"
              ? body.error
              : "Could not load supplier POs.",
          );
        if (active) setData(body as SupplierOrdersResponse);
      } catch (error) {
        if (active)
          setError(
            error instanceof Error
              ? error.message
              : "Could not load supplier POs.",
          );
      }
    })();
    return () => {
      active = false;
    };
  }, [caseId, retry]);
  if (error)
    return (
      <div role="alert" className="p-4 text-[11px] text-[#b3261e]">
        {error}
        <button
          className="ml-2 font-medium underline"
          onClick={() => setRetry((value) => value + 1)}
        >
          Retry
        </button>
      </div>
    );
  if (!data)
    return (
      <p
        role="status"
        className="flex items-center gap-2 p-4 text-[11px] text-[#6b5d50]"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading supplier POs…
      </p>
    );
  const query = search.trim().toLowerCase();
  const orders = data.orders.filter((order) =>
    [
      order.number,
      order.reference,
      ...order.lines.flatMap((item) => [item.item, item.description]),
    ]
      .join(" ")
      .toLowerCase()
      .includes(query),
  );
  const selected = orders.filter((order) =>
    order.selectedFor.includes(line.index),
  );
  const other = orders.filter(
    (order) => !order.selectedFor.includes(line.index),
  );
  const groups = [
    { label: "Used for this match", orders: selected },
    {
      label: "Other SAP Purchase Orders",
      orders: other.filter((order) => order.source === "SAP Purchase Orders"),
    },
    {
      label: "Open PO report",
      orders: other.filter((order) => order.source === "Open PO report"),
    },
  ];
  const hasSelected = data.orders.some((order) =>
    order.selectedFor.includes(line.index),
  );
  return (
    <>
      <div className="shrink-0 border-b border-[#e0d8cc] px-4 py-2">
        <p className="text-[11px] text-[#3d3530]">
          {data.vendor.cardName}{" "}
          <span className="text-[#6b5d50]">({data.vendor.cardCode})</span>
        </p>
        <p className="mt-0.5 text-[10px] text-[#6b5d50]">
          Current open POs + linked match POs · {data.orders.length} entries
        </p>
        <label className="mt-2 flex items-center gap-2 rounded-md border border-[#d4c9bc] bg-white px-2 py-1.5">
          <Search className="h-3 w-3 text-[#6b5d50]" />
          <input
            aria-label="Search supplier POs"
            placeholder="PO number or item"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[11px] outline-none"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {data.warnings.map((warning) => (
          <p
            key={warning}
            className="mb-2 text-[10px] leading-4 text-[#9a5a0a]"
          >
            {warning}
          </p>
        ))}
        {!hasSelected && line.po ? (
          <p className="mb-3 text-[11px] text-[#9a5a0a]">
            Matching PO{" "}
            {line.po.docNum ?? line.po.ref ?? "reference unavailable"} is not
            available in the current SAP Purchase Orders response.
          </p>
        ) : null}
        {groups
          .filter((group) => group.orders.length)
          .map((group) => (
            <section key={group.label} className="mb-4">
              <h3 className="mb-2 text-[11px] font-semibold text-[#3d3530]">
                {group.label} ({group.orders.length})
              </h3>
              <ul className="space-y-1.5">
                {group.orders.map((order) => (
                  <OrderCard key={order.id} order={order} line={line} />
                ))}
              </ul>
            </section>
          ))}
        {!orders.length ? (
          <p className="text-[11px] text-[#6b5d50]">
            {query
              ? "No POs match this search."
              : "No supplier POs returned by SAP."}
          </p>
        ) : null}
      </div>
    </>
  );
}

export function SupplierOrdersPanel({
  caseId,
  line,
}: {
  caseId: string;
  line: LineResult;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#d4c9bc] bg-[#fcfbf9] px-2.5 py-1 text-[11px] font-medium text-[#5d422e] hover:bg-[#f0ece4] focus-visible:outline-2 focus-visible:outline-[#2d6a4f]"
        >
          Supplier POs
          <ChevronRight className="h-3 w-3" />
        </button>
      </DialogTrigger>
      <DialogPortal>
        <DialogOverlay className="bg-slate-950/25 backdrop-blur-none" />
        <DialogContent className="fixed inset-y-0 right-0 z-50 flex h-dvh w-full max-w-[480px] flex-col border-l border-[#e0d8cc] bg-[#faf8f4] shadow-2xl outline-none">
          <header className="shrink-0 border-b border-[#e0d8cc] bg-white px-4 py-3">
            <DialogTitle className="pr-9 text-[13px] font-semibold text-[#111827]">
              Supplier POs
            </DialogTitle>
            <DialogDescription className="mt-0.5 pr-8 text-[11px] leading-4 text-[#6b5d50]">
              Invoice line {line.index + 1}
              {line.itemCode ? ` · ${line.itemCode}` : ""} · Read-only
            </DialogDescription>
            <DialogClose className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full text-[#6b5d50] hover:bg-[#f0ece4] focus-visible:outline-2 focus-visible:outline-[#2d6a4f]">
              <X className="h-3.5 w-3.5" />
              <span className="sr-only">Close supplier POs</span>
            </DialogClose>
          </header>
          {open ? <OrderList caseId={caseId} line={line} /> : null}
        </DialogContent>
      </DialogPortal>
    </Dialog>
  );
}
