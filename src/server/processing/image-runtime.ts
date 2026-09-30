import sharp from "sharp";

const configuredConcurrency = Number(
  process.env.PACKET_NATIVE_IMAGE_CONCURRENCY ?? 1,
);

// Native image allocations live outside the JavaScript heap. Bound them for
// long-lived workers and make the deployment choice explicit/configurable.
sharp.cache(false);
sharp.concurrency(
  Number.isFinite(configuredConcurrency) && configuredConcurrency >= 1
    ? Math.min(4, Math.floor(configuredConcurrency))
    : 1,
);

export default sharp;
