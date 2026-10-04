"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { fetchSapMatchRules } from "@/lib/sap-match-client";
import type { MatchRules } from "@/lib/sap-match/types";
import { SapMatchingRulesEditor } from "./SapMatchingRulesEditor";

export function SapMatchingSettings() {
  const [rules, setRules] = useState<MatchRules | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null);
    void fetchSapMatchRules().then(
      (loaded) => {
        if (active) setRules(loaded);
      },
      (failure) => {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load SAP matching rules.",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  return (
    <div id="sap-matching" className="mt-6 scroll-mt-6">
      {rules ? (
        <SapMatchingRulesEditor rules={rules} onSaved={setRules} />
      ) : (
        <section className="rounded-xl border border-[#e0d8cc] bg-white p-4 text-[11px]">
          <h2 className="text-[12px] font-semibold">SAP matching rules</h2>
          {error ? (
            <div className="mt-2">
              <p role="alert" className="text-[#b3261e]">
                {error}
              </p>
              <button
                type="button"
                className="mt-2 underline"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry SAP matching rules
              </button>
            </div>
          ) : (
            <p
              role="status"
              className="mt-2 flex items-center gap-2 text-[#6b6258]"
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading SAP matching rules…
            </p>
          )}
        </section>
      )}
    </div>
  );
}
