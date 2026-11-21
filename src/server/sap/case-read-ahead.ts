import { createHash } from "node:crypto";
import type { CaseDoc } from "@/types/pipeline";
import { serializeFieldsWithLineItems } from "@/server/line-items";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { requireActiveSapCase } from "./case-environment";
import {
  readSapServiceConnection,
  sapCaseOrigin,
  type SapEnvironment,
} from "./config";
import { computeCaseMatch } from "./match-data";
import { SapReadAhead } from "./read-ahead";
import { withSapServiceLayer } from "./service-layer";

type CaseScope = {
  id: string;
  owner_user_id: string;
  created_at: unknown;
  processing_meta?: unknown;
};
type Handle = {
  commit: () => void;
  discard: () => void;
  finished: Promise<void>;
};
const pending = new Map<
  string,
  {
    scope: string;
    reads: SapReadAhead;
    ready: boolean;
    expiresAt: number;
    stop: () => void;
  }
>();

function scopeKey(row: CaseScope, environment: SapEnvironment) {
  // A connection, user, project or company change invalidates old reads.
  // Credentials are only hashed in memory and are never logged or persisted.
  return createHash("sha256")
    .update(
      JSON.stringify({
        caseId: row.id,
        owner: row.owner_user_id,
        environment,
        project: process.env.NEXT_PUBLIC_SUPABASE_URL,
        connection: readSapServiceConnection(environment),
      }),
    )
    .digest("hex");
}

export function discardCaseSapReadAhead(caseId: string) {
  const entry = pending.get(caseId);
  if (!entry) return;
  pending.delete(caseId);
  entry.stop();
}

/** Starts only speculative reads. It cannot save or publish a SAP match. */
export function startCaseSapReadAhead(params: {
  db: ReturnType<typeof createSupabaseAdminClient>;
  caseRow: CaseScope;
  documents: CaseDoc[];
}): Handle | undefined {
  discardCaseSapReadAhead(params.caseRow.id);
  if (process.env.SAP_MATCH_READ_AHEAD_ENABLED === "false") return;
  if (
    params.documents.filter(
      (doc) => doc.type === "Invoice" || doc.type === "Tax Invoice",
    ).length !== 1
  )
    return;
  let environment: SapEnvironment, scope: string;
  try {
    environment = requireActiveSapCase(
      sapCaseOrigin(params.caseRow.created_at, params.caseRow.processing_meta),
    );
    scope = scopeKey(params.caseRow, environment);
  } catch {
    return;
  } // Missing/historical SAP configuration never blocks analysis.
  for (const [caseId, entry] of pending) {
    if (entry.expiresAt <= Date.now()) discardCaseSapReadAhead(caseId);
  }
  // Limit rebuildable data to two runs (at most 8 MB of read responses each).
  while (pending.size >= 2)
    discardCaseSapReadAhead(pending.keys().next().value!);
  const controller = new AbortController();
  const reads = new SapReadAhead();
  const timer = setTimeout(() => {
    reads.dispose();
    controller.abort();
  }, 30_000);
  timer.unref();
  const entry = {
    scope,
    reads,
    ready: false,
    expiresAt: Date.now() + 90_000,
    stop: () => {
      clearTimeout(timer);
      clearTimeout(expiry);
      controller.abort();
      reads.dispose();
    },
  };
  pending.set(params.caseRow.id, entry);
  const expiry = setTimeout(() => {
    if (pending.get(params.caseRow.id) === entry)
      discardCaseSapReadAhead(params.caseRow.id);
  }, 90_000);
  expiry.unref();
  const finished = withSapServiceLayer(
    (client) =>
      computeCaseMatch({
        db: params.db,
        client,
        environment,
        reads: reads.capture,
        caseRow: {
          id: params.caseRow.id,
          invoice_number: null,
          po_number: null,
        },
        packet: {
          documents: params.documents.map((doc) => ({
            client_document_id: doc.id,
            document_type: doc.type,
            extracted_fields: serializeFieldsWithLineItems(doc),
            source_file_name: doc.sourceFileName,
            source_hint: doc.sourceHint,
          })),
          mismatchAttributions: [],
        },
      }),
    environment,
    { signal: controller.signal },
  )
    .catch(() => {
      /* Final matching retries missing reads normally. */
    })
    .finally(() => clearTimeout(timer));
  return {
    finished: finished.then(() => undefined),
    commit: () => {
      if (pending.get(params.caseRow.id) === entry) entry.ready = true;
    },
    discard: () => {
      if (pending.get(params.caseRow.id) === entry)
        discardCaseSapReadAhead(params.caseRow.id);
    },
  };
}

/** Only a completed analysis may hand its reads to the durable matching job. */
export function takeCaseSapReadAhead(
  caseRow: CaseScope,
  environment: SapEnvironment,
) {
  const entry = pending.get(caseRow.id);
  if (!entry || !entry.ready) return;
  pending.delete(caseRow.id);
  let sameScope = false;
  try {
    sameScope = entry.scope === scopeKey(caseRow, environment);
  } catch {
    /* A changed/incomplete connection can only use the normal read path. */
  }
  if (entry.expiresAt <= Date.now() || !sameScope) {
    entry.stop();
    return;
  }
  return {
    reads: entry.reads.consume,
    reusedReads: () => entry.reads.reusedReads,
    dispose: entry.stop,
  };
}
