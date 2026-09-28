"use client";

import { Play, Sparkles } from "lucide-react";

import { ANALYSIS_MODE_COPY, getAnalysisModeTitle } from "@/lib/analysis-mode";
import type { CaseAnalysisMode } from "@/types/pipeline";

type AnalysisModeActionsProps = {
  disabled: boolean;
  retry?: boolean;
  onSelect: (mode: CaseAnalysisMode) => void;
};

const MODES: CaseAnalysisMode[] = ["standard", "smart_split"];

export function AnalysisModeActions({
  disabled,
  retry = false,
  onSelect,
}: AnalysisModeActionsProps) {
  return (
    <div className="w-full">
      <div
        className="grid gap-3 sm:grid-cols-2"
        aria-label="Choose how to analyze this upload"
      >
        {MODES.map((mode) => {
          const copy = ANALYSIS_MODE_COPY[mode];
          const Icon = mode === "standard" ? Play : Sparkles;

          return (
            <button
              key={mode}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(mode)}
              className={`group rounded-2xl border p-4 text-left shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
                mode === "standard"
                  ? "border-[#1a1a1a] bg-[#1a1a1a] text-white hover:bg-[#2d2d2d]"
                  : "border-emerald-200 bg-emerald-50 text-emerald-950 hover:border-emerald-300 hover:bg-emerald-100"
              }`}
            >
              <span className="flex items-center gap-2">
                <Icon
                  className={`h-5 w-5 shrink-0 ${
                    mode === "standard" ? "fill-white" : "text-emerald-700"
                  }`}
                />
                <span className="text-sm font-bold sm:text-base">
                  {getAnalysisModeTitle(mode, retry)}
                </span>
              </span>
              <span
                className={`mt-2 block text-xs leading-relaxed ${
                  mode === "standard" ? "text-zinc-300" : "text-emerald-800"
                }`}
              >
                {copy.description}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-center text-[11px] font-medium text-[#8a7f72]">
        Not sure? Choose <strong>Analyze as one case</strong>.
      </p>
    </div>
  );
}
