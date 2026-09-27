// Server-only SAP SPAPI configuration. Credentials never leave the server.
// The Test/Live OpenPO + OpenGRPO endpoints supplied by the SAP team are
// GET-only reads; document creation needs separate POST URLs (see sap-post).

export type SapEnvironment = "test" | "live";

export function readSapEnvironment(): SapEnvironment {
  return process.env.SAP_API_ENV === "live" ? "live" : "test";
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
