import type { GrpoPdfAvailability } from "@/lib/grpo-import";
import type { SapInspectorRecord } from "@/lib/sap-inspector";
import { pdfAttachments } from "./grpo-pdf";

/** Inspect actual SAP metadata; a failed read must never be called a missing PDF. */
export async function grpoPdfAvailability(
  records: Pick<SapInspectorRecord, "docEntry" | "raw">[],
  read: (entry: number) => Promise<Record<string, unknown>>,
) {
  const result: Record<string, GrpoPdfAvailability> = {};
  const pending = new Map<number, Promise<GrpoPdfAvailability>>();
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, records.length) }, async () => {
      while (index < records.length) {
        const record = records[index++];
        const entry = record.raw.AttachmentEntry;
        let value: GrpoPdfAvailability;
        if (entry === null || entry === -1 || entry === 0)
          value = { status: "missing", count: 0 };
        else if (
          typeof entry !== "number" ||
          !Number.isSafeInteger(entry) ||
          entry < 0
        )
          value = { status: "unavailable" };
        else {
          if (!pending.has(entry))
            pending.set(
              entry,
              (async () => {
                try {
                  const body = await read(entry);
                  if (!Array.isArray(body.Attachments2_Lines))
                    return { status: "unavailable" } as const;
                  const count = pdfAttachments(
                    entry,
                    body.Attachments2_Lines,
                  ).length;
                  return {
                    status: count > 0 ? "available" : "missing",
                    count,
                  } as GrpoPdfAvailability;
                } catch {
                  return { status: "unavailable" } as const;
                }
              })(),
            );
          value = await pending.get(entry)!;
        }
        result[String(record.docEntry)] = value;
      }
    }),
  );
  return result;
}
