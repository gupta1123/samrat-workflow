// Server-only SAP SPAPI configuration. Credentials never leave the server.
// The Test/Live OpenPO + OpenGRPO endpoints supplied by the SAP team are
// GET-only reads; document creation needs separate POST URLs (see sap-post).

export type SapEnvironment = "test" | "live";

export function readSapEnvironment(): SapEnvironment {
  const mode = process.env.SAP_API_ENV?.trim();
  if (!mode || mode === "test") return "test";
  if (mode !== "live") throw new Error("Invalid SAP_API_ENV.");
  const cutoff = Date.parse(process.env.SAP_LIVE_CASES_FROM ?? "");
  if (!Number.isFinite(cutoff))
    throw new Error("SAP Production cutover is not configured.");
  return Date.now() >= cutoff ? "live" : "test";
}

function required(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) throw new Error(`Missing ${name}. See .env.example SAP section.`);
  return value;
}

export function readSapConnection(env: SapEnvironment = readSapEnvironment()) {
  const prefix = env === "live" ? "SAP_LIVE" : "SAP_TEST";
  return {
    env,
    baseUrl: required(`${prefix}_BASE_URL`).replace(/\/+$/, ""),
    username: required(`${prefix}_USERNAME`),
    password: required(`${prefix}_PASSWORD`),
  };
}

// Future create endpoints. Empty until the SAP team shares POST URLs for
// GRPO (GRN) and AP Invoice creation. The API returns a clear
// SAP_CREATE_API_MISSING response while these are unset.
export function readSapCreateUrls() {
  return {
    grn: (process.env.SAP_CREATE_GRPO_URL ?? "").trim(),
    ap: (process.env.SAP_CREATE_AP_URL ?? "").trim(),
  };
}

export function readSapServiceConnection(
  env: SapEnvironment = readSapEnvironment(),
) {
  const prefix = env === "live" ? "SAP_SL_LIVE" : "SAP_SL_TEST";
  const baseUrl = required(`${prefix}_BASE_URL`).replace(/\/+$/, "");
  const company = required(`${prefix}_COMPANY_DB`);
  if (!baseUrl.startsWith("https://") || !baseUrl.endsWith("/b1s/v1")) {
    throw new Error("SAP Service Layer URL must be an HTTPS /b1s/v1 endpoint.");
  }
  if (
    env === "live" &&
    company.toUpperCase() ===
      process.env.SAP_SL_TEST_COMPANY_DB?.trim().toUpperCase()
  ) {
    throw new Error("SAP Production and Test must use different companies.");
  }
  return {
    baseUrl,
    company,
    username: required(`${prefix}_USERNAME`),
    password: required(`${prefix}_PASSWORD`),
  };
}

export function sapCaseEnvironment(createdAt: unknown): SapEnvironment {
  const cutoff = process.env.SAP_LIVE_CASES_FROM;
  if (!cutoff && readSapEnvironment() === "test") return "test";
  const boundary = Date.parse(cutoff ?? "");
  const created = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(boundary) || !Number.isFinite(created)) {
    throw new Error(
      "SAP case environment is not configured or the case date is missing.",
    );
  }
  return created >= boundary ? "live" : "test";
}

export function sapEnvironmentLabel(environment: SapEnvironment) {
  return environment === "live" ? "SAP Production" : "SAP Test";
}

export function sapCompanyKey(key: string, environment = readSapEnvironment()) {
  return environment === "live"
    ? `live:${readSapServiceConnection("live").company}:${key}`
    : key;
}

// Analysis can split a packet into new rows. Their SAP company follows the
// original upload even when the split is saved after the cutover.
export function sapCaseOrigin(createdAt: unknown, processingMeta: unknown) {
  if (!processingMeta || typeof processingMeta !== "object") return createdAt;
  const origin = (processingMeta as Record<string, unknown>).sapOriginCreatedAt;
  return typeof origin === "string" ? origin : createdAt;
}
