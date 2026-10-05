"use client";

import { useEffect, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchDraftHeaderPreview } from "@/lib/sap-match-client";
import type {
  DraftFieldChoices,
  DraftHeaderPreview,
} from "@/lib/sap-draft-fields";

/** Only fetch SAP field definitions when the user opens the posting review. */
export function DraftHeaderFields({
  caseId,
  confirming = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  caseId: string;
  confirming?: boolean;
  busy?: boolean;
  onConfirm?: (choices: DraftFieldChoices) => void;
  onCancel?: () => void;
}) {
  const [preview, setPreview] = useState<DraftHeaderPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<DraftFieldChoices>({});
  useEffect(() => {
    let active = true;
    fetchDraftHeaderPreview(caseId)
      .then((value) => {
        if (!active) return;
        setPreview(value);
        setChoices({
          materialForm: value.materialForm.selectedValue,
          transporter: value.transporter.selectedValue,
        });
      })
      .catch((error) => {
        if (active)
          setError(
            error instanceof Error
              ? error.message
              : "Could not load draft fields.",
          );
      });
    return () => {
      active = false;
    };
  }, [caseId]);
  return (
    <div className="space-y-2 text-[11px] text-[#3d3530]">
      {error ? (
        <p className="text-[#b91c1c]">{error}</p>
      ) : !preview ? (
        <p className="flex items-center gap-1.5 text-[#8a7f72]">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading SAP draft fields…
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-[minmax(120px,1fr)_minmax(120px,2fr)] gap-x-3 gap-y-1">
            {preview.fields
              .filter((field) => !["U_TRSPRT", "U_MTRFORM"].includes(field.key))
              .map((field) => (
                <div key={field.key} className="contents">
                  <dt className="text-[#8a7f72]">{field.label}</dt>
                  <dd title={field.source}>
                    {field.value ?? "Not recorded in PDF"}
                  </dd>
                </div>
              ))}
          </dl>
          {confirming ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {(["transporter", "materialForm"] as const).map((key) => (
                <label key={key} className="space-y-1">
                  <span className="block font-medium">
                    {key === "transporter" ? "Transporter" : "Material Form"}
                  </span>
                  <select
                    aria-label={
                      key === "transporter"
                        ? "Draft Transporter"
                        : "Draft Material Form"
                    }
                    disabled={busy}
                    value={choices[key] ?? ""}
                    onChange={(event) =>
                      setChoices((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                    className="h-8 w-full rounded-md border border-[#e0d8cc] bg-white px-2 text-[11px]"
                  >
                    <option value="">Select from SAP…</option>
                    {preview[key].options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          ) : (
            <dl className="grid grid-cols-[minmax(120px,1fr)_minmax(120px,2fr)] gap-x-3 gap-y-1">
              {preview.fields
                .filter((field) =>
                  ["U_TRSPRT", "U_MTRFORM"].includes(field.key),
                )
                .map((field) => (
                  <div key={field.key} className="contents">
                    <dt className="text-[#8a7f72]">{field.label}</dt>
                    <dd>{field.value ?? "Select before creating draft"}</dd>
                  </div>
                ))}
            </dl>
          )}
          {preview.warnings.map((warning) => (
            <p key={warning} className="text-[#9a5a0a]">
              {warning}
            </p>
          ))}
        </>
      )}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            size="sm"
            className="h-7 text-[11px]"
            disabled={
              busy ||
              !preview ||
              !!error ||
              !choices.materialForm ||
              !choices.transporter
            }
            onClick={() => onConfirm?.(choices)}
          >
            {busy ? (
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
            ) : (
              <Send className="mr-1.5 h-3 w-3" />
            )}
            Confirm draft
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <span className="text-[#8a7f72]">Creates a draft in SAP Test.</span>
        </div>
      ) : null}
    </div>
  );
}
