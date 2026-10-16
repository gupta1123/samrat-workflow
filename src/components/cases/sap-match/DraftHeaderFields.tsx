"use client";

import { useEffect, useRef, useState } from "react";
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
  numberingSeriesRetry = false,
}: {
  caseId: string;
  confirming?: boolean;
  busy?: boolean;
  onConfirm?: (choices: DraftFieldChoices) => void;
  onCancel?: () => void;
  numberingSeriesRetry?: boolean;
}) {
  const [preview, setPreview] = useState<DraftHeaderPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<DraftFieldChoices>({});
  const [showSeries, setShowSeries] = useState(numberingSeriesRetry);
  const [fetching, setFetching] = useState(true);
  const [retryVersion, setRetryVersion] = useState(0);
  const initializedCase = useRef<string | null>(null);
  useEffect(() => {
    if (numberingSeriesRetry) setShowSeries(true);
  }, [numberingSeriesRetry]);
  useEffect(() => {
    let active = true;
    setError(null);
    setFetching(true);
    if (initializedCase.current !== caseId) {
      setPreview(null);
      setChoices({});
    }
    fetchDraftHeaderPreview(caseId, showSeries)
      .then((value) => {
        if (!active) return;
        setPreview(value);
        if (initializedCase.current !== caseId) {
          setChoices({
            materialForm: value.materialForm.selectedValue,
            transporter: value.transporter.selectedValue,
          });
          initializedCase.current = caseId;
        }
      })
      .catch((error) => {
        if (active)
          setError(
            error instanceof Error
              ? error.message
              : "Could not load draft fields.",
          );
      })
      .finally(() => {
        if (active) setFetching(false);
      });
    return () => {
      active = false;
    };
  }, [caseId, showSeries, retryVersion]);
  return (
    <div className="space-y-2 text-[11px] text-[#3d3530]">
      {error ? (
        <p role="alert" className="text-[#b91c1c]">
          {error}{" "}
          <button
            type="button"
            disabled={busy || fetching}
            className="underline"
            onClick={() => setRetryVersion((value) => value + 1)}
          >
            Retry
          </button>
        </p>
      ) : null}
      {fetching && preview ? (
        <p role="status">Updating SAP draft fields…</p>
      ) : null}
      {!preview ? (
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
                ? "Matched directly to the PO"
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
          {confirming ? (
            showSeries ? (
              <div className="space-y-1 rounded-lg border border-[#e0d8cc] bg-[#faf8f4] p-3">
                <label
                  htmlFor={`series-${caseId}`}
                  className="block font-medium"
                >
                  SAP numbering series
                </label>
                <select
                  id={`series-${caseId}`}
                  disabled={busy}
                  className="w-full rounded-md border border-[#e0d8cc] bg-white p-2"
                  value={choices.numberingSeries ?? ""}
                  onChange={(event) =>
                    setChoices((current) => ({
                      ...current,
                      numberingSeries: event.target.value
                        ? Number(event.target.value)
                        : undefined,
                    }))
                  }
                >
                  <option value="">Choose a SAP series…</option>
                  {preview.numberingSeries?.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="text-[#6b5d50]">
                  SAP series for posting date{" "}
                  {preview.numberingSeries?.postingDate}. No series is selected
                  automatically. SAP validates posting permissions and period
                  status when you confirm.
                </p>
                {!preview.numberingSeries?.options.length ? (
                  <p className="text-[#b91c1c]">
                    No available series returned for this date and branch.
                    Contact your SAP administrator.
                  </p>
                ) : null}
              </div>
            ) : (
              <button
                type="button"
                disabled={busy}
                className="text-[#6b4a33] underline"
                onClick={() => setShowSeries(true)}
              >
                Choose a different SAP numbering series
              </button>
            )
          ) : null}
        </>
      )}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            size="sm"
            className="h-7 text-[11px]"
            disabled={
              busy ||
              fetching ||
              !preview ||
              !!error ||
              (showSeries && !choices.numberingSeries) ||
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
