import { ApiError } from "@/server/api/helpers";
import { sapFetch } from "./http";
import { downloadGrpoPdfs } from "./grpo-attachments-api";

export type GrpoPdfFile = {
  attachmentEntry?: number;
  name: string;
  index: number;
  sha256?: string;
};
export function grpoEntry(value: unknown) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new ApiError("Invalid SAP GRPO entry.");
  return id;
}
export function pdfAttachments(entry: unknown, lines: unknown): GrpoPdfFile[] {
  if (
    !Number.isSafeInteger(entry) ||
    Number(entry) <= 0 ||
    !Array.isArray(lines)
  )
    return [];
  return lines
    .flatMap((line) => {
      if (
        !line ||
        typeof line !== "object" ||
        String(line.FileExtension).toLowerCase() !== "pdf"
      )
        return [];
      const name = `${line.FileName}.${line.FileExtension}`;
      if (
        typeof line.FileName !== "string" ||
        name.length > 240 ||
        /[\x00-\x1f/\\]/.test(name)
      )
        throw new ApiError("SAP returned an invalid PDF filename.", 502);
      return [{ attachmentEntry: Number(entry), name, index: 0 }];
    })
    .map((file, index) => ({ ...file, index }));
}
export async function readBoundedPdf(response: Response) {
  const max = 50 * 1024 * 1024;
  if (!response.ok)
    throw new ApiError(
      `SAP PDF download failed (HTTP ${response.status}).`,
      502,
    );
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw new ApiError("SAP PDF exceeds the 50 MB file limit.", 413);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError("SAP returned an empty document.", 502);
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max)
        throw new ApiError("SAP PDF exceeds the 50 MB file limit.", 413);
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = Buffer.concat(parts);
  if (bytes.subarray(0, 5).toString() !== "%PDF-")
    throw new ApiError("SAP did not return a PDF. No case was created.", 502);
  return bytes;
}

/** Verify the live SAP Test receipt; download only from the SAP team's attachment API. */
export async function withGrpoPdfs<T>(
  entry: number,
  action: (source: {
    company: string;
    docNum: number;
    files: GrpoPdfFile[];
    download: (index: number) => Promise<Buffer>;
  }) => Promise<T>,
) {
  const base = (process.env.SAP_SL_TEST_BASE_URL ?? "").replace(/\/+$/, "");
  const company = process.env.SAP_SL_TEST_COMPANY_DB ?? "";
  if (
    !base.startsWith("https://") ||
    !base.endsWith("/b1s/v1") ||
    !company ||
    !process.env.SAP_SL_TEST_USERNAME ||
    !process.env.SAP_SL_TEST_PASSWORD
  )
    throw new ApiError("SAP Test attachment access is not configured.", 503);
  let cookie = "";
  const request = async (path: string, init: RequestInit = {}) =>
    sapFetch(base + path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...init.headers,
      },
      redirect: "error",
      cache: "no-store",
      signal: init.signal ?? AbortSignal.timeout(35_000),
    });
  const json = async (path: string, init?: RequestInit) => {
    const r = await request(path, init);
    if (!r.ok)
      throw new ApiError(
        `Could not read SAP attachments (HTTP ${r.status}).`,
        502,
      );
    return { r, body: await r.json() };
  };
  const login = await json("/Login", {
    method: "POST",
    body: JSON.stringify({
      CompanyDB: company,
      UserName: process.env.SAP_SL_TEST_USERNAME,
      Password: process.env.SAP_SL_TEST_PASSWORD,
    }),
  });
  if (!login.body.SessionId)
    throw new ApiError("SAP did not return an attachment session.", 502);
  cookie = [
    `B1SESSION=${login.body.SessionId}`,
    login.r.headers.get("set-cookie")?.match(/ROUTEID=[^;\s,]+/)?.[0],
  ]
    .filter(Boolean)
    .join("; ");
  try {
    const { body: receipt } = await json(
      `/PurchaseDeliveryNotes(${grpoEntry(entry)})`,
    );
    if (
      receipt.DocEntry !== entry ||
      receipt.DocumentStatus !== "bost_Open" ||
      receipt.Cancelled !== "tNO"
    )
      throw new ApiError(
        "This GRPO is no longer open in SAP. Refresh the list.",
        409,
      );
    if (!Number.isSafeInteger(receipt.DocNum))
      throw new ApiError("SAP receipt identity is unavailable.", 502);
    const pdfs = await downloadGrpoPdfs(entry);
    const files = pdfs.map(({ name, sha256 }, index) => ({
      name,
      sha256,
      index,
    }));
    return await action({
      company,
      docNum: receipt.DocNum,
      files,
      download: async (index) => {
        const file = files[index];
        if (!file) throw new ApiError("Invalid PDF selection.");
        return pdfs[index].bytes;
      },
    });
  } finally {
    await request("/Logout", {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
}
