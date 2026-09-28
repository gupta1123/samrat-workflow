import {
  readSapConnection,
  readSapEnvironment,
  type SapEnvironment,
} from "./config";
import { sapFetch } from "./http";

export type SapOpenPoRow = Record<string, unknown> & {
  DocEntry?: number;
  DocNum?: number | string;
};

export type SapOpenGrpoRow = Record<string, unknown> & {
  DocNum?: number | string;
};

type CacheEntry = { expiresAt: number; rows: Record<string, unknown>[] };

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

async function getRows(
  env: SapEnvironment,
  path: "OpenPO" | "OpenGRPO",
): Promise<Record<string, unknown>[]> {
  const connection = readSapConnection(env);
  const cacheKey = `${env}:${path}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await sapFetch(`${connection.baseUrl}/SPAPI/${path}`, {
      method: "GET",
      headers: {
        Authorization: basicAuth(connection.username, connection.password),
        Accept: "application/json",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`SAP ${path} responded with HTTP ${response.status}.`);
    }
    const body = (await response.json()) as {
      success?: boolean;
      data?: Record<string, unknown>[];
      message?: string;
    };
    if (body.success === false) {
      throw new Error(
        typeof body.message === "string" && body.message
          ? body.message
          : `SAP ${path} reported failure.`,
      );
    }
    const rows = Array.isArray(body.data) ? body.data : [];
    cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, rows });
    return rows;
  } finally {
    clearTimeout(timeout);
  }
}

export function fetchSapOpenPOs(env?: SapEnvironment) {
  return getRows(env ?? readSapEnv(), "OpenPO");
}

export function fetchSapOpenGRPOs(env?: SapEnvironment) {
  return getRows(env ?? readSapEnv(), "OpenGRPO");
}

function readSapEnv(): SapEnvironment {
  return readSapEnvironment();
}

export function clearSapCache() {
  cache.clear();
}
