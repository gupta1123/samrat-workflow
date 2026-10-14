"use client";

import { useState, type ReactNode } from "react";
import { Check, Minus, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { matchTimestamp } from "@/lib/sap-match/evidence";
import type { ReviewTone } from "@/lib/sap-match/review-model";
import type {
  MatchCheck,
  MatchInvoice,
  MatchResult,
} from "@/lib/sap-match/types";
import { inr } from "./format";

// The top of the SAP tab: one status line and four tiles. Opening a tile shows
// what the invoice says next to what SAP has, side by side.

const DOT: Record<ReviewTone, string> = {
  ok: "bg-[#2c8a5f]",
  todo: "bg-[#d98e1f]",
  bad: "bg-[#c2412f]",
  off: "bg-[#a89c8e]",
};

type TileKey = "supplier" | "item" | "total" | "receipts";
type TileMode = "ok" | "warn" | "off";

type Tile = {
  key: TileKey;
  label: string;
  value: ReactNode;
  sub: ReactNode;
  mode: TileMode;
  /** Clicking the tile opens the receipts drawer of this invoice line. */
  opens?: number;
  detail?: {
    invoice: { main: ReactNode; sub: ReactNode };
    sap: { main: ReactNode; sub: ReactNode };
  };
};

const mono = (value: string | null | undefined) => (
  <span className="font-mono">{value || "—"}</span>
);

function buildTiles(
  invoice: MatchInvoice,
  vendor: { cardCode: string; cardName: string } | null,
  result: MatchResult,
): Tile[] {
  const lines = result.lines;
  const unmapped = lines.filter((line) => line.kind === "unmapped");
  const material = lines.filter((line) => line.kind === "material");
  const services = lines.filter((line) => line.kind === "service");
  const pendingServiceItems = services.filter(
    (line) =>
      !line.itemCode &&
      line.candidates.some(
        (candidate) =>
          candidate.documentType === "dDocument_Items" && !candidate.rejected,
      ),
  );
  const plan = result.payload;

  const supplier: Tile = {
    key: "supplier",
    label: "Supplier",
    value: vendor ? vendor.cardName : "Not linked",
    sub: vendor ? vendor.cardCode : (invoice.vendorName ?? ""),
    mode: vendor ? "ok" : "warn",
    detail: {
      invoice: {
        main: invoice.vendorName ?? "—",
        sub: invoice.vendorGstin ? (
          <>GSTIN {mono(invoice.vendorGstin)}</>
        ) : (
          "GSTIN not on the invoice"
        ),
      },
      sap: {
        main: vendor?.cardName ?? "Not linked",
        sub: vendor ? <>Code {mono(vendor.cardCode)}</> : "",
      },
    },
  };

  const itemNames = (pick: (index: number) => ReactNode) =>
    lines.map((line, i) => <div key={line.index}>{pick(i)}</div>);
  const item: Tile = {
    key: "item",
    label: lines.length > 1 ? "Items" : "Item",
    value:
      lines.length === 1
        ? pendingServiceItems.length
          ? "Confirm PO item"
          : services.length && !lines[0].itemCode
            ? "No stock item needed"
            : unmapped.length
              ? "Not linked"
              : mono(lines[0].itemCode)
        : `${lines.length} items`,
    sub:
      lines.length === 1
        ? pendingServiceItems.length
          ? "Select the service's SAP item with its PO line"
          : unmapped.length
            ? (invoice.lines[0]?.description ?? "")
            : (lines[0].itemName ?? "")
        : unmapped.length
          ? `${unmapped.length} not linked`
          : [...new Set(lines.map((line) => line.itemCode))].join(", "),
    mode: unmapped.length || pendingServiceItems.length ? "warn" : "ok",
    detail: {
      invoice: {
        main: itemNames(
          (i) => invoice.lines[lines[i].index]?.description ?? "—",
        ),
        sub: itemNames((i) => (
          <>Code {mono(invoice.lines[lines[i].index]?.vendorItemCode)}</>
        )),
      },
      sap: {
        main: itemNames((i) => lines[i].itemName ?? "Not linked"),
        sub: itemNames((i) => <>Code {mono(lines[i].itemCode)}</>),
      },
    },
  };

  const off = plan && Math.abs(plan.difference ?? 0) > 1;
  const total: Tile = plan
    ? {
        key: "total",
        label: "Draft total",
        value: inr(plan.bookedTaxable),
        sub: off
          ? `Differs by ${inr(Math.abs(plan.difference ?? 0))}`
          : "Matches invoice",
        mode: off ? "warn" : "ok",
        detail: {
          invoice: { main: inr(plan.invoiceTaxable), sub: "Before tax" },
          sap: { main: inr(plan.bookedTaxable), sub: "Before tax" },
        },
      }
    : {
        key: "total",
        label: "Draft total",
        value: "—",
        sub: "Needs a match first",
        mode: "off",
      };

  let receipts: Tile;
  if (!material.length && services.length) {
    const po = services[0].po;
    const linkedCount = services.filter(
      (line) => line.po?.docNum != null,
    ).length;
    const hasCandidates = services.some((line) =>
      line.candidates.some((candidate) => !candidate.rejected),
    );
    receipts = {
      key: "receipts",
      label: "Purchase Order",
      value:
        services.length > 1
          ? `${linkedCount} of ${services.length} linked`
          : po?.docNum != null
            ? `PO ${po.docNum}`
            : hasCandidates
              ? "Choose PO"
              : "No eligible PO",
      sub:
        services.length > 1
          ? `${services.length} service lines`
          : "Service · no GRPO needed",
      mode: linkedCount === services.length ? "ok" : "warn",
    };
  } else if (!material.length) {
    receipts = {
      key: "receipts",
      label: "Receipts",
      value: "—",
      sub: "Needs items linked",
      mode: "off",
    };
  } else {
    const chosen = material.flatMap((line) =>
      line.candidates.filter(
        (candidate) => candidate.kind === "GRPO" && candidate.allocated > 0,
      ),
    );
    const considered = material.reduce(
      (n, line) => n + line.candidates.length,
      0,
    );
    const target =
      material.find(
        (line) =>
          !line.candidates.some(
            (candidate) => candidate.kind === "GRPO" && candidate.allocated > 0,
          ),
      ) ?? material[0];
    const opens = considered ? target.index : undefined;
    receipts = chosen.length
      ? {
          key: "receipts",
          label: "Receipts",
          value: `${chosen.length} GRPO${chosen.length === 1 ? "" : "s"}`,
          sub: [...new Set(chosen.map((c) => c.docNum))].slice(0, 4).join(", "),
          mode: "ok",
          opens,
        }
      : {
          key: "receipts",
          label: "Receipts",
          value: "No GRPO found",
          sub: `${considered} considered`,
          mode: "warn",
          opens,
        };
  }
  return [supplier, item, total, receipts];
}

function TileButton({
  tile,
  open,
  onToggle,
}: {
  tile: Tile;
  open: boolean;
  onToggle: () => void;
}) {
  const tone =
    tile.mode === "warn"
      ? "border-[#f0d7a6] bg-[#fffaf0]"
      : tile.mode === "off"
        ? "border-[#e0d8cc] bg-[#faf8f4]"
        : "border-[#e0d8cc] bg-white";
  const valueTone =
    tile.mode === "warn"
      ? "text-[#8a5207]"
      : tile.mode === "off"
        ? "text-[#a89c8e]"
        : "text-[#111827]";
  const Icon = tile.mode === "ok" ? Check : tile.mode === "off" ? Minus : null;
  const inner = (
    <>
      <span className="flex items-center gap-1.5 text-[11px] text-[#6b5d50]">
        <span
          className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${tile.mode === "warn" ? "bg-[#fdf1dc] text-[#8a5207]" : tile.mode === "off" ? "bg-[#ece6dc] text-[#a89c8e]" : "bg-[#e3f1e8] text-[#2c6a4f]"}`}
        >
          {Icon ? <Icon className="h-2.5 w-2.5" strokeWidth={3.2} /> : "!"}
        </span>
        {tile.label}
      </span>
      <span className={`block truncate text-[13px] font-semibold ${valueTone}`}>
        {tile.value}
      </span>
      <span className="block truncate text-[11px] text-[#6b5d50]">
        {tile.sub}
      </span>
    </>
  );
  const className = `grid min-w-0 gap-[3px] rounded-[10px] border px-3.5 py-3 text-left ${tone}`;
  if (!tile.detail && tile.opens === undefined)
    return <div className={className}>{inner}</div>;
  return (
    <button
      type="button"
      {...(tile.detail
        ? { "aria-expanded": open }
        : { "aria-haspopup": "dialog" })}
      onClick={onToggle}
      className={`${className} transition-colors hover:border-[#c9bfae] ${open ? "border-[#3f8a63] shadow-[0_0_0_3px_rgba(63,138,99,0.1)]" : ""}`}
    >
      {inner}
    </button>
  );
}

export function ReviewHeader({
  title,
  tone,
  env,
  invoice,
  vendor,
  result,
  unchecked,
  checkedAt,
  savedLabel,
  busy,
  onRefresh,
  onOpenReceipts,
  extras,
}: {
  title: string;
  tone: ReviewTone;
  env: string;
  invoice: MatchInvoice;
  vendor: { cardCode: string; cardName: string } | null;
  result: MatchResult;
  unchecked: MatchCheck[];
  checkedAt?: string | null;
  /** Set once a draft is saved; replaces the re-check button. */
  savedLabel?: string | null;
  busy: boolean;
  onRefresh: () => void;
  /** Opens the receipts drawer for a line; the Receipts tile calls it. */
  onOpenReceipts?: (lineIndex: number) => void;
  /** Extra evidence shown at the bottom of a tile's detail panel. */
  extras?: Partial<Record<TileKey, ReactNode>>;
}) {
  const [open, setOpen] = useState<TileKey | null>(null);
  const tiles = buildTiles(invoice, vendor, result);
  const active = tiles.find((tile) => tile.key === open && tile.detail);
  const index = active ? tiles.indexOf(active) : 0;
  const names = unchecked.map(
    (check) =>
      ({ branch: "branch", tax: "GST type", period: "posting period" })[
        check.id
      ] ?? check.title.split(" (")[0].toLowerCase(),
  );
  const list =
    names.length > 1
      ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
      : names[0];

  return (
    <div className="space-y-2">
      <section className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-2.5 text-[18px] font-semibold tracking-[-0.02em] text-[#111827]">
          <span className={`h-[9px] w-[9px] rounded-full ${DOT[tone]}`} />
          {title}
        </h2>
        <div className="ml-auto flex items-center gap-2">
          <span className="rounded-md bg-[#fdf1dc] px-2 py-1 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-[#8a5207]">
            SAP {env === "test" ? "Test" : env}
          </span>
          {savedLabel ? (
            <span className="text-[11px] text-[#6b5d50]">{savedLabel}</span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-[11px] text-[#6b5d50]"
              disabled={busy}
              onClick={onRefresh}
              title="Re-check with SAP"
            >
              <RefreshCw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} />
              {matchTimestamp(checkedAt) === "Time not recorded"
                ? "Re-check"
                : matchTimestamp(checkedAt)}
            </Button>
          )}
        </div>
      </section>

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {tiles.map((tile) => (
          <TileButton
            key={tile.key}
            tile={tile}
            open={open === tile.key}
            onToggle={() =>
              tile.opens !== undefined
                ? onOpenReceipts?.(tile.opens)
                : setOpen(open === tile.key ? null : tile.key)
            }
          />
        ))}
      </div>

      {active?.detail ? (
        <div
          className="relative mt-1.5 grid rounded-[10px] bg-[#efeae1] py-1 sm:grid-cols-2"
          data-tile={index}
        >
          <span
            aria-hidden="true"
            style={{
              left: `calc((100% - 30px) / 4 * ${index + 0.5} + 10px * ${index} - 5px)`,
            }}
            className="absolute -top-[5px] hidden h-2.5 w-2.5 rotate-45 rounded-tl-sm bg-[#efeae1] lg:block"
          />
          {(["invoice", "sap"] as const).map((side) => (
            <div
              key={side}
              className={`min-w-0 px-[18px] py-3 ${side === "sap" ? "sm:border-l sm:border-[rgba(43,26,16,0.1)]" : ""}`}
            >
              <div className="mb-1 text-[10.5px] text-[#6b5d50]">
                {side === "invoice" ? "On the invoice" : "In SAP"}
              </div>
              <div className="break-words text-[12.5px] font-medium leading-[1.35] text-[#111827]">
                {active.detail![side].main}
              </div>
              <div className="mt-0.5 text-[11.5px] text-[#6b5d50]">
                {active.detail![side].sub}
              </div>
            </div>
          ))}
          {extras?.[active.key] ? (
            <div className="min-w-0 border-t border-[rgba(43,26,16,0.1)] px-[18px] py-3 text-[11px] sm:col-span-2">
              <div className="mb-1.5 text-[10.5px] text-[#6b5d50]">
                How it was matched
              </div>
              {extras[active.key]}
            </div>
          ) : null}
        </div>
      ) : null}

      {names.length ? (
        <p className="text-[11.5px] text-[#6b5d50]">
          {list.charAt(0).toUpperCase() + list.slice(1)}{" "}
          {names.length > 1 ? "are" : "is"} not checked.
        </p>
      ) : null}
    </div>
  );
}
