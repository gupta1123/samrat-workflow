"use client";

import { useEffect, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchDraftHeaderPreview } from "@/lib/sap-match-client";
import type {
  DraftFieldChoices,
  DraftHeaderPreview,
} from "@/lib/sap-draft-fields";
import { draftSelectionsComplete } from "@/lib/sap-draft-fields";
import { SearchSelect } from "@/components/ui/search-select";
import { PostingFieldGrid } from "./PostingFieldGrid";

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
          <div className="space-y-2">
            {confirming ? (
              <PostingFieldGrid
                fields={preview.fields.filter((field) =>
                  ["U_TATAINV", "U_TATAINVDT", "NumAtCard", "TaxDate"].includes(
                    field.key,
                  ),
                )}
              />
            ) : null}
            <h3 className="text-[11px] font-semibold text-[#111827]">
              {preview.service
                ? "Service invoice — matched directly to the PO"
                : "Transport & weights"}
            </h3>
            <PostingFieldGrid
              fields={preview.fields.filter(
                (field) =>
                  ![
                    "U_TATAINV",
                    "U_TATAINVDT",
                    "U_TRSPRT",
                    "U_MTRFORM",
                    ...(confirming ? ["NumAtCard", "TaxDate"] : []),
                  ].includes(field.key),
              )}
            />
          </div>
          {/* Choices are editable only in the explicit creation confirmation. */}
          {confirming ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {(["transporter", "materialForm"] as const)
                .filter((key) => !preview.service || preview[key].required)
                .map((key) => (
                  <div key={key} className="space-y-1">
                    <span className="block text-[10px] font-medium text-[#6b5d50]">
                      {key === "transporter" ? "Transporter" : "Material Form"}
                    </span>
                    <SearchSelect
                      ariaLabel={
                        key === "transporter"
                          ? "Draft Transporter"
                          : "Draft Material Form"
                      }
                      disabled={busy}
                      options={preview[key].options}
                      value={choices[key] ?? ""}
                      placeholder="Search SAP…"
                      onChange={(value) =>
                        setChoices((current) => ({ ...current, [key]: value }))
                      }
                    />
                  </div>
                ))}
            </div>
          ) : (
            <PostingFieldGrid
              fields={preview.fields.filter((field) =>
                ["U_TRSPRT", "U_MTRFORM"].includes(field.key),
              )}
            />
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
              Boolean(preview && !draftSelectionsComplete(preview, choices))
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
