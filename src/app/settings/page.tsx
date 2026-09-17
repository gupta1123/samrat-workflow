"use client";
import { AppShell } from "@/components/dashboard/AppShell";
import { apiFetch } from "@/lib/api-client";
import {
  fetchComparisonGroups,
  type ComparisonFieldGroup,
} from "@/lib/comparison-groups";
import {
  DOC_TYPE_EXTRACTION_FIELDS,
  FIELD_LABELS,
} from "@/lib/document-schema";
import type { DocType } from "@/types/pipeline";
import { Loader2, Save, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";

type Field = { doc_type: string; field_key: string; enabled: boolean };
type Doc = { doc_type: string; enabled: boolean };
const types = Object.keys(DOC_TYPE_EXTRACTION_FIELDS).filter(
  (t) => !["Bank Statement", "Unknown"].includes(t),
) as DocType[];
export default function SettingsPage() {
  const [fields, setFields] = useState<Field[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [groups, setGroups] = useState<ComparisonFieldGroup[]>([]);
  const [selected, setSelected] = useState<DocType>("Invoice");
  const [state, setState] = useState<"loading" | "ready" | "saving" | "error">(
    "loading",
  );
  const [message, setMessage] = useState("");
  const [dirty, setDirty] = useState(false);
  async function load() {
    setState("loading");
    setMessage("");
    try {
      const [response, comparison] = await Promise.all([
        apiFetch("/api/settings/field"),
        fetchComparisonGroups(),
      ]);
      if (!response.ok)
        throw new Error(
          "Could not load review settings. Check your connection and retry.",
        );
      const data = await response.json();
      setFields(data.fieldSettings);
      setDocs(data.docTypeSettings);
      setGroups(comparison);
      setState("ready");
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error ? e.message : "Could not load settings.");
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function toggleField(key: string, enabled: boolean) {
    setFields((rows) => [
      ...rows.filter((r) => r.doc_type !== selected || r.field_key !== key),
      { doc_type: selected, field_key: key, enabled },
    ]);
    setDirty(true);
    setMessage("");
  }
  async function save() {
    setState("saving");
    setMessage("");
    try {
      const response = await apiFetch("/api/settings/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields, docs, groups }),
      });
      if (!response.ok)
        throw new Error(
          "Settings could not be saved. Your changes are still here; please retry.",
        );

      setDirty(false);
      setMessage(
        "Review settings saved. They apply to the next analysis; existing results are unchanged.",
      );
      setState("ready");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not save settings.");
      setState("ready");
    }
  }
  return (
    <AppShell>
      <div className="mx-auto max-w-6xl p-5 pb-28 sm:p-8">
        <form
          method="post"
          action="/auth/signout"
          className="mb-5 text-right md:hidden"
        >
          <button className="text-sm text-slate-500 underline">Sign out</button>
        </form>
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-emerald-700">
              Samrat Group
            </p>
            <h1 className="mt-2 text-3xl font-semibold text-slate-900">
              Review settings
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-500">
              Choose the documents and fields checked during analysis. These
              settings are shared across this workspace. Changing them does not
              alter a completed review.
            </p>
          </div>
          <button
            disabled={!dirty || state !== "ready"}
            onClick={save}
            className="flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-3 text-sm font-medium text-white disabled:opacity-40"
          >
            {state === "saving" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save changes
          </button>
        </header>
        {message && (
          <p
            role="status"
            className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm"
          >
            {message}
          </p>
        )}
        {state === "loading" ? (
          <div className="mt-12 flex items-center gap-3 text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading review settings…
          </div>
        ) : state === "error" ? (
          <button onClick={load} className="mt-4 underline">
            Retry
          </button>
        ) : (
          <>
            <section className="mt-8 grid overflow-hidden rounded-xl border border-slate-200 bg-white md:grid-cols-[240px_1fr]">
              <div className="border-b border-slate-200 bg-slate-50 p-3 md:border-b-0 md:border-r">
                <h2 className="px-3 py-3 text-sm font-semibold">
                  Document types
                </h2>
                <div className="flex gap-2 overflow-x-auto md:block md:space-y-1">
                  {types.map((t) => (
                    <button
                      key={t}
                      onClick={() => setSelected(t)}
                      className={`block shrink-0 rounded-lg px-3 py-2.5 text-left text-sm md:w-full ${selected === t ? "bg-white font-medium text-emerald-800 shadow-sm" : "text-slate-600 hover:bg-white"}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div className="p-5 sm:p-7">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-semibold">{selected}</h2>
                    <p className="mt-2 text-sm text-slate-500">
                      Enabled fields are extracted and checked where comparable.
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={
                        docs.find((d) => d.doc_type === selected)?.enabled !==
                        false
                      }
                      onChange={(e) => {
                        setDocs((rows) => [
                          ...rows.filter((d) => d.doc_type !== selected),
                          { doc_type: selected, enabled: e.target.checked },
                        ]);
                        setDirty(true);
                        setMessage("");
                      }}
                    />
                    Enabled
                  </label>
                </div>
                <fieldset
                  disabled={
                    docs.find((d) => d.doc_type === selected)?.enabled === false
                  }
                  className="mt-7 grid gap-3 sm:grid-cols-2 disabled:opacity-40"
                >
                  {DOC_TYPE_EXTRACTION_FIELDS[selected].map((key) => (
                    <label
                      key={key}
                      className="flex items-center gap-3 rounded-lg border border-slate-100 px-3 py-3 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-emerald-700"
                        checked={
                          fields.find(
                            (f) =>
                              f.doc_type === selected && f.field_key === key,
                          )?.enabled !== false
                        }
                        onChange={(e) => toggleField(key, e.target.checked)}
                      />
                      {FIELD_LABELS[key]}
                    </label>
                  ))}
                </fieldset>
              </div>
            </section>
            <section className="mt-7 rounded-xl border border-slate-200 bg-white p-6">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <Settings2 className="h-5 w-5" />
                Mismatch review groups
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                Organize the issues shown in the review screen.
              </p>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {groups.map((g, i) => (
                  <label
                    key={g.groupKey}
                    className="flex items-start gap-3 rounded-lg border border-slate-200 p-4"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 accent-emerald-700"
                      checked={g.enabled}
                      onChange={(e) => {
                        setGroups((rows) =>
                          rows.map((r, j) =>
                            j === i ? { ...r, enabled: e.target.checked } : r,
                          ),
                        );
                        setDirty(true);
                      }}
                    />
                    <span>
                      <span className="text-sm font-medium">{g.label}</span>
                      <span className="mt-1 block text-xs leading-5 text-slate-500">
                        {g.fields
                          .map(
                            (k) =>
                              FIELD_LABELS[k as keyof typeof FIELD_LABELS] || k,
                          )
                          .join(", ")}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}
