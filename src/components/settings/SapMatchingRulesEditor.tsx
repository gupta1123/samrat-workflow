"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { saveSapMatchRules } from "@/lib/sap-match-client";
import type {
  BranchMapping,
  FreightPolicy,
  MatchRules,
} from "@/lib/sap-match/types";

const FREIGHT: Array<[FreightPolicy, string]> = [
  ["expense", "As a freight charge on the invoice"],
  ["item", "Added into the material cost"],
  ["separate", "Excluded; invoiced against a separate freight PO"],
];

// Your company's matching policy. One set of rules for the whole app.
export function SapMatchingRulesEditor({
  rules,
  onSaved,
}: {
  rules: MatchRules;
  onSaved: (rules: MatchRules) => void;
}) {
  const [form, setFormState] = useState(() => ({
    ...rules,
    qtyTolerancePct: String(rules.qtyTolerancePct),
    rateTolerancePct: String(rules.rateTolerancePct),
    receiptWindowDays: String(rules.receiptWindowDays),
    branches: rules.branches.map((branch) => ({
      ...branch,
      bplId: branch.bplId === null ? "" : String(branch.bplId),
      warehouse: branch.warehouse ?? "",
    })),
  }));
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const disabled = saving;
  const [message, setMessage] = useState<{
    text: string;
    failed: boolean;
  } | null>(null);

  function setForm(next: typeof form) {
    setFormState(next);
    setDirty(true);
    setMessage(null);
  }

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    setSaving(true);
    setMessage(null);
    const branches: BranchMapping[] = form.branches.map((branch) => ({
      stateCode: branch.stateCode.trim(),
      name: branch.name.trim(),
      bplId: branch.bplId.trim() === "" ? null : Number(branch.bplId),
      warehouse: branch.warehouse.trim() || null,
    }));
    const updatedRules: MatchRules = {
      qtyTolerancePct: Number(form.qtyTolerancePct),
      rateTolerancePct: Number(form.rateTolerancePct),
      freightPolicy: form.freightPolicy,
      postingDate: form.postingDate,
      receiptWindowDays: Math.round(Number(form.receiptWindowDays)),
      branches,
    };
    try {
      const result = await saveSapMatchRules(updatedRules);
      if (!result.ok) throw new Error(result.error ?? "Could not save.");
      setDirty(false);
      setMessage({
        text: "SAP matching rules saved. They apply to subsequent checks. Use Re-check on an existing case to apply them.",
        failed: false,
      });
      onSaved(updatedRules);
    } catch (error) {
      setMessage({
        text:
          error instanceof Error
            ? error.message
            : "Could not save. Your changes are still here; please retry.",
        failed: true,
      });
    } finally {
      setSaving(false);
    }
  }

  const input =
    "h-8 min-w-0 rounded-md border border-[#cfc4b8] bg-white px-2 text-[11px] text-[#111827] outline-none focus:border-[#2d6a4f] disabled:opacity-60";
  return (
    <section className="rounded-xl border border-[#e0d8cc] bg-white">
      <header className="px-4 py-3">
        <h2 className="text-[12px] font-semibold text-[#111827]">
          SAP matching rules
        </h2>
        <p className="mt-1 text-[11px] text-[#6b6258]">
          Shared policy for all cases. Changes apply when a case is checked
          again.
        </p>
      </header>
      <div className="space-y-4 border-t border-[#ece6dc] px-4 py-4 text-[11px] text-[#3d3530]">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="font-semibold">Quantity tolerance (%)</span>
            <span className="mt-0.5 block text-[10px] text-[#8a7f72]">
              Invoice Qty. above allocated GRPO Qty. within this tolerance needs
              review; SAP quantity limits still apply.
            </span>
            <input
              className={`${input} mt-1 w-full`}
              type="number"
              min="0"
              max="100"
              step="any"
              inputMode="decimal"
              disabled={disabled}
              value={form.qtyTolerancePct}
              onChange={(event) =>
                setForm({ ...form, qtyTolerancePct: event.target.value })
              }
            />
          </label>
          <label className="block">
            <span className="font-semibold">Unit price tolerance (%)</span>
            <span className="mt-0.5 block text-[10px] text-[#8a7f72]">
              Invoice Unit Price above or below the PO Unit Price by more than
              this needs a written reason.
            </span>
            <input
              className={`${input} mt-1 w-full`}
              type="number"
              min="0"
              max="100"
              step="any"
              inputMode="decimal"
              disabled={disabled}
              value={form.rateTolerancePct}
              onChange={(event) =>
                setForm({ ...form, rateTolerancePct: event.target.value })
              }
            />
          </label>
          <label className="block">
            <span className="font-semibold">GRPO matching window (days)</span>
            <span className="mt-0.5 block text-[10px] text-[#8a7f72]">
              GRPOs within this window after the Document Date rank higher.
            </span>
            <input
              className={`${input} mt-1 w-full`}
              type="number"
              min="0"
              max="365"
              step="1"
              inputMode="numeric"
              disabled={disabled}
              value={form.receiptWindowDays}
              onChange={(event) =>
                setForm({ ...form, receiptWindowDays: event.target.value })
              }
            />
          </label>
        </div>
        <fieldset>
          <legend className="font-semibold">Freight on stock invoices</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {FREIGHT.map(([value, label]) => (
              <label key={value} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="freight"
                  disabled={disabled}
                  checked={form.freightPolicy === value}
                  onChange={() => setForm({ ...form, freightPolicy: value })}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="font-semibold">Posting Date</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {(
              [
                ["invoice", "The vendor's invoice date"],
                ["today", "Today's date"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="postingDate"
                  disabled={disabled}
                  checked={form.postingDate === value}
                  onChange={() => setForm({ ...form, postingDate: value })}
                />
                {label}
              </label>
            ))}
            <span className="text-[10px] text-[#8a7f72]">
              The Document Date always stays the vendor&apos;s invoice date.
            </span>
          </div>
        </fieldset>
        <div>
          <div className="font-semibold">Branches</div>
          <div className="mt-0.5 text-[10px] text-[#8a7f72]">
            Links the ship-to GSTIN state code (the first two digits, e.g. 36)
            to your SAP branch so GRPOs at another branch are left out.
          </div>
          <div className="mt-2 space-y-2">
            {form.branches.map((branch, index) => (
              <div
                key={index}
                className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[4rem_1fr_5rem_6rem_2rem]"
              >
                <input
                  className={input}
                  placeholder="State"
                  aria-label={`Branch ${index + 1} GST state code`}
                  maxLength={2}
                  disabled={disabled}
                  value={branch.stateCode}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      branches: form.branches.map((entry, i) =>
                        i === index
                          ? { ...entry, stateCode: event.target.value }
                          : entry,
                      ),
                    })
                  }
                />
                <input
                  className={input}
                  placeholder="Branch name"
                  aria-label={`Branch ${index + 1} name`}
                  disabled={disabled}
                  value={branch.name}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      branches: form.branches.map((entry, i) =>
                        i === index
                          ? { ...entry, name: event.target.value }
                          : entry,
                      ),
                    })
                  }
                />
                <input
                  className={input}
                  placeholder="SAP BPL ID"
                  aria-label={`Branch ${index + 1} SAP BPL ID`}
                  inputMode="numeric"
                  disabled={disabled}
                  value={branch.bplId}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      branches: form.branches.map((entry, i) =>
                        i === index
                          ? { ...entry, bplId: event.target.value }
                          : entry,
                      ),
                    })
                  }
                />
                <input
                  className={input}
                  placeholder="Warehouse"
                  aria-label={`Branch ${index + 1} warehouse`}
                  disabled={disabled}
                  value={branch.warehouse}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      branches: form.branches.map((entry, i) =>
                        i === index
                          ? { ...entry, warehouse: event.target.value }
                          : entry,
                      ),
                    })
                  }
                />
                <button
                  type="button"
                  aria-label="Remove branch"
                  disabled={disabled}
                  className="text-[#b3261e]"
                  onClick={() =>
                    setForm({
                      ...form,
                      branches: form.branches.filter((_, i) => i !== index),
                    })
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-[11px]"
              disabled={disabled}
              onClick={() =>
                setForm({
                  ...form,
                  branches: [
                    ...form.branches,
                    { stateCode: "", name: "", bplId: "", warehouse: "" },
                  ],
                })
              }
            >
              <Plus className="h-3 w-3" /> Add branch
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            className="h-8 px-3 text-[11px]"
            disabled={saving || !dirty}
            onClick={() => void save()}
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null} Save
            SAP matching rules
          </Button>
          {message ? (
            <span
              role={message.failed ? "alert" : "status"}
              className={message.failed ? "text-[#b3261e]" : "text-[#1b4332]"}
            >
              {message.text}
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
