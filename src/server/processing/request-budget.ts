// Transport capacity, not a document classification rule. Keep headroom below
// the observed 20,000,000-byte provider limit for routing/serialization overhead.
export function requestByteLimit() {
  const configured = Number(process.env.PACKET_REQUEST_MAX_BYTES ?? 16_000_000);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 16_000_000)
    : 16_000_000;
}

export class RequestSizeError extends Error {
  constructor(
    public readonly bytes: number,
    public readonly limit: number,
  ) {
    super(
      `Document processing request requires ${bytes} bytes; safe capacity is ${limit} bytes.`,
    );
    this.name = "RequestSizeError";
  }
}

export function assertRequestFits(body: string, limit = requestByteLimit()) {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > limit) throw new RequestSizeError(bytes, limit);
  return bytes;
}

/** Exact serialized-byte packing: never skip, truncate or reorder an item. */
export function packRequestBatches<T>(
  items: T[],
  serialize: (batch: T[]) => string,
  limit = requestByteLimit(),
  maxItems = Number.MAX_SAFE_INTEGER,
): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  for (const item of items) {
    const proposed = [...batch, item];
    if (
      proposed.length > maxItems ||
      Buffer.byteLength(serialize(proposed), "utf8") > limit
    ) {
      if (batch.length) batches.push(batch);
      batch = [item];
      assertRequestFits(serialize(batch), limit);
    } else batch = proposed;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
