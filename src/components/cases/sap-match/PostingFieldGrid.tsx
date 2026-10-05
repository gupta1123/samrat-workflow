import { formatDate, qty } from "./format";
import type { DraftHeaderPreview } from "@/lib/sap-draft-fields";
import { previewSource } from "@/lib/sap-posting-preview";

export function SourceTag({ source }: { source: string }) {
  return (
    <span className="ml-1.5 whitespace-nowrap rounded bg-[#f2efe9] px-1 py-0.5 text-[9px] font-normal text-[#8a7f72]">
      {source}
    </span>
  );
}

export function PostingFieldGrid({
  fields,
  sap = false,
}: {
  fields: DraftHeaderPreview["fields"];
  sap?: boolean;
}) {
  return (
    <dl className="grid gap-x-5 gap-y-1.5 text-[11px] sm:grid-cols-2">
      {fields.map((field) => {
        const missing = field.value === null || field.value === "";
        const value = missing
          ? "Not recorded"
          : /date/i.test(field.label)
            ? formatDate(String(field.value).slice(0, 10))
            : /weight|quantity/i.test(field.label) &&
                Number.isFinite(Number(field.value))
              ? qty(Number(field.value))
              : String(field.value);
        return (
          <div
            key={field.key}
            className="flex min-w-0 items-baseline justify-between gap-3"
          >
            <dt className="text-[#8a7f72]">{field.label}</dt>
            <dd
              className={`text-right ${missing ? "text-[#8a7f72]" : "font-medium text-[#3d3530]"}`}
              title={field.source}
            >
              {value}
              {!missing ? (
                <SourceTag source={sap ? "SAP" : previewSource(field.source)} />
              ) : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
