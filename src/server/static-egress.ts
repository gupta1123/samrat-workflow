import { X509Certificate } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type StaticEgressProxy = {
  url: URL;
  ca: string | null;
  custom: boolean;
};

/** Keep the existing provider available until the new gateway is switched on. */
export function readStaticEgressProxy(): StaticEgressProxy | null {
  const customUrl = process.env.STATIC_EGRESS_PROXY_URL?.trim();
  const value = customUrl || process.env.QUOTAGUARDSTATIC_URL?.trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      (customUrl && url.protocol !== "https:") ||
      (url.pathname && url.pathname !== "/") ||
      url.search ||
      url.hash
    )
      throw new Error();
  } catch {
    // Never include the URL here: it contains the gateway's credentials.
    throw new Error("The secure connection settings are invalid.");
  }

  const encodedCa = customUrl
    ? process.env.STATIC_EGRESS_PROXY_CA_BASE64?.trim()
    : null;
  let ca: string | null = null;
  if (encodedCa) {
    try {
      ca = Buffer.from(encodedCa, "base64").toString("utf8");
      new X509Certificate(ca);
    } catch {
      throw new Error("The secure connection certificate is invalid.");
    }
  }
  return { url, ca, custom: Boolean(customUrl) };
}

const certificateFiles = new Map<string, string>();

/** curl requires a file; reuse one private temporary file per certificate. */
export function proxyCertificateFile(ca: string): string {
  const existing = certificateFiles.get(ca);
  if (existing) return existing;
  const directory = mkdtempSync(join(tmpdir(), "samrat-egress-ca-"));
  const path = join(directory, "ca.pem");
  writeFileSync(path, ca, { mode: 0o600 });
  certificateFiles.set(ca, path);
  return path;
}
