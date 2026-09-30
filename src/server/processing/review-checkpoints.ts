import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { createSupabaseAdminClient } from "../supabase/admin";
import {
  checkpointContractForStage,
  type ReviewCheckpointStage,
} from "./checkpoint-contract";

export type ReviewCheckpointStore = {
  read(key: string): Promise<string | null>;
  write(key: string, raw: string): Promise<void>;
};

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, ordered(entry)]),
    );
  return value;
}
export function reviewInputDigest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(ordered(value)))
    .digest("hex");
}
export function reviewCheckpointKey(
  stage: ReviewCheckpointStage,
  input: unknown,
) {
  return `${stage}/${reviewInputDigest({ contract: checkpointContractForStage(stage), input })}`;
}

// Server-only objects in the existing PRIVATE upload bucket. They have no
// storage_asset/case-file row and therefore cannot be opened by the file API.
// caseId comes from the owned, claimed job, never a browser-supplied path.
export function createReviewCheckpointStore(
  db: ReturnType<typeof createSupabaseAdminClient>,
  caseId: string,
  assertLease: () => Promise<void>,
) {
  const prefix = `_review_checkpoints/${caseId}`;
  const usedPaths = new Set<string>();
  const ttlMs = 72 * 60 * 60_000;
  const stageNames = new Set<ReviewCheckpointStage>([
    "extraction",
    "source",
    "packet",
    "decisions",
    "root-causes",
  ]);
  let bucketCheck: Promise<void> | undefined;
  const requirePrivateBucket = () =>
    (bucketCheck ??= (async () => {
      const { data, error } = await db.storage.getBucket("packet-files");
      if (error) throw error;
      if (!data || data.public !== false)
        throw new Error(
          "Internal review checkpoints require a private storage bucket.",
        );
    })());
  const addressFor = (key: string) => {
    const parts = key.split("/");
    const stage = parts[0] as ReviewCheckpointStage;
    if (
      parts.length !== 2 ||
      !stageNames.has(stage) ||
      parts[1].length !== 64 ||
      [...parts[1]].some((char) => !"0123456789abcdef".includes(char))
    )
      throw new Error("Invalid internal review checkpoint address.");
    return {
      path: `${prefix}/${key}.json.gz`,
      contract: checkpointContractForStage(stage),
    };
  };
  const store: ReviewCheckpointStore = {
    async read(key) {
      await assertLease();
      await requirePrivateBucket();
      const { path, contract } = addressFor(key);
      usedPaths.add(path);
      const { data, error } = await db.storage
        .from("packet-files")
        .download(path);
      if (error) {
        if (
          String(error.statusCode) === "404" ||
          error.message === "Object not found"
        )
          return null;
        throw error;
      }
      try {
        const envelope = JSON.parse(
          gunzipSync(new Uint8Array(await data.arrayBuffer())).toString("utf8"),
        );
        if (
          envelope.contract !== contract ||
          envelope.key !== key ||
          typeof envelope.raw !== "string" ||
          typeof envelope.createdAt !== "number" ||
          Date.now() - envelope.createdAt > ttlMs ||
          envelope.createdAt > Date.now()
        )
          return null;
        return envelope.raw;
      } catch {
        // A corrupt checkpoint is never a verified result. Regenerate the stage
        // and pass its complete source contract before publishing anything.
        return null;
      }
    },
    async write(key, raw) {
      await assertLease();
      await requirePrivateBucket();
      const { path, contract } = addressFor(key);
      usedPaths.add(path);
      const bytes = gzipSync(
        JSON.stringify({
          contract,
          key,
          createdAt: Date.now(),
          raw,
        }),
      );
      const { error } = await db.storage
        .from("packet-files")
        .upload(path, bytes, {
          contentType: "application/octet-stream",
          upsert: true,
        });
      if (error) throw error;
      await assertLease();
    },
  };
  return {
    store,
    async clearUsed() {
      if (!usedPaths.size) return;
      try {
        const { error } = await db.storage
          .from("packet-files")
          .remove([...usedPaths]);
        if (error)
          console.warn(
            "Unable to clear completed internal review checkpoints.",
          );
      } catch {
        console.warn("Unable to clear completed internal review checkpoints.");
      }
    },
  };
}

export async function cachedReviewStage<T>(options: {
  key: string;
  store?: ReviewCheckpointStore;
  validate: (raw: string) => T;
  run: () => Promise<{ raw: string; result: T; attempts?: number }>;
  cacheWhen?: (result: T) => boolean;
}) {
  const saved = await options.store?.read(options.key);
  if (saved !== undefined && saved !== null) {
    try {
      return { result: options.validate(saved), reused: true, attempts: 0 };
    } catch {
      /* Revalidate the original stage; never waive the source contract. */
    }
  }
  const completed = await options.run();
  const verified = options.validate(completed.raw);
  if (!options.cacheWhen || options.cacheWhen(verified))
    await options.store?.write(options.key, completed.raw);
  return {
    result: verified,
    reused: false,
    attempts: completed.attempts ?? 0,
  };
}
