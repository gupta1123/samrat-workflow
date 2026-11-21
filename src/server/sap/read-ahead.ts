import { createHash } from "node:crypto";
import type { MatchInvoice } from "@/lib/sap-match/types";
import type { CaseMatchClient, CaseMatchReads } from "./match-data";

// Duplicate checks, draft reads and all writes deliberately bypass this list.
const REUSABLE_READS = new Set([
  "getSupplier",
  "searchSuppliers",
  "listSuppliers",
  "findOpenReceiptDocumentsForInvoice",
  "listOpenReceiptDocumentsForVendor",
  "listOpenPurchaseOrdersForVendor",
  "listPurchaseOrdersByEntries",
  "listItemsByCodes",
  "searchItems",
  "getAdminCurrencies",
]);
const MAX_BYTES = 8 * 1024 * 1024;
export const SAP_READ_AHEAD_MAX_AGE_MS = 30_000;

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function invoiceDigest(invoice: MatchInvoice) {
  // Packet reconciliation adds field-origin labels after source review. They
  // do not change a SAP query. Every financial value, reference and line stays
  // in the fingerprint, and the final match keeps the final source labels.
  return digest({ ...invoice, fieldSources: undefined });
}

type Entry = {
  startedAt: number;
  searches: unknown[];
  pending: Promise<{ value: unknown } | null>;
};

/** One invoice, one case and one analysis run; never a shared supplier cache. */
export class SapReadAhead {
  private invoiceKey: string | undefined;
  private entries = new Map<string, Entry>();
  private bytes = 0;
  private disposed = false;
  private oldestReusedAt: number | undefined;
  reusedReads = 0;

  constructor(private readonly now: () => number = Date.now) {}

  readonly capture: CaseMatchReads = {
    clientForInvoice: (invoice, client) => {
      this.invoiceKey = invoiceDigest(invoice);
      return this.wrap(client, true);
    },
  };

  readonly consume: CaseMatchReads = {
    clientForInvoice: (invoice: MatchInvoice, client) =>
      !this.disposed && this.invoiceKey === invoiceDigest(invoice)
        ? this.wrap(client, false)
        : client,
    checkedAt: () =>
      this.oldestReusedAt === undefined
        ? undefined
        : new Date(this.oldestReusedAt).toISOString(),
  };

  dispose() {
    this.disposed = true;
    this.entries.clear();
    this.bytes = 0;
  }

  private fresh(entry: Entry) {
    const age = this.now() - entry.startedAt;
    return !this.disposed && age >= 0 && age <= SAP_READ_AHEAD_MAX_AGE_MS;
  }

  private wrap(client: CaseMatchClient, capture: boolean): CaseMatchClient {
    return new Proxy(client, {
      get: (target, property, receiver) => {
        const method = Reflect.get(target, property, receiver);
        if (
          capture &&
          typeof method === "function" &&
          typeof property === "string" &&
          !/^(get|list|find|search)/.test(property)
        ) {
          return async () => {
            throw new Error("SAP preparation only permits read-only methods.");
          };
        }
        if (
          typeof property !== "string" ||
          typeof method !== "function" ||
          !REUSABLE_READS.has(property)
        )
          return method;
        return async (...args: unknown[]) => {
          const key = `${property}:${digest(args)}`;
          const callback =
            property === "findOpenReceiptDocumentsForInvoice"
              ? (args[0] as { onSearch?: (event: unknown) => void }).onSearch
              : undefined;
          const entry = this.entries.get(key);
          if (!capture && entry && this.fresh(entry)) {
            const cached = await entry.pending;
            // Recheck freshness after an in-flight lookup finishes. Errors,
            // expired reads and over-budget responses always use normal SAP.
            if (cached && this.fresh(entry)) {
              for (const event of entry.searches)
                callback?.(structuredClone(event));
              this.oldestReusedAt = Math.min(
                this.oldestReusedAt ?? entry.startedAt,
                entry.startedAt,
              );
              this.reusedReads++;
              return structuredClone(cached.value);
            }
          }
          if (!capture || this.disposed) return method.apply(target, args);

          const searches: unknown[] = [];
          const actualArgs = callback
            ? [
                {
                  ...(args[0] as object),
                  onSearch: (event: unknown) => {
                    searches.push(structuredClone(event));
                    callback(event);
                  },
                },
              ]
            : args;
          // Always install the search observer, even if preparation has no
          // caller callback; the final match still needs its discovery metadata.
          if (property === "findOpenReceiptDocumentsForInvoice" && !callback) {
            actualArgs[0] = {
              ...(args[0] as object),
              onSearch: (event: unknown) =>
                searches.push(structuredClone(event)),
            };
          }
          const startedAt = this.now();
          let original: unknown;
          const pending = Promise.resolve()
            .then(() => method.apply(target, actualArgs))
            .then((value) => {
              original = value;
              const size = Buffer.byteLength(JSON.stringify(value) ?? "null");
              if (this.disposed || this.bytes + size > MAX_BYTES) return null;
              const copy = structuredClone(value);
              this.bytes += size;
              return { value: copy };
            });
          // Capture failure immediately so an early read never creates an
          // unhandled rejection. The preparation call itself still sees it.
          this.entries.set(key, {
            startedAt,
            searches,
            pending: pending.catch(() => null),
          });
          await pending;
          return original;
        };
      },
    });
  }
}
