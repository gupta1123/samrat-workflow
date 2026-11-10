import { createHash } from "node:crypto";
import { basename } from "node:path/posix";
import { crc32 } from "node:zlib";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { ApiError } from "@/server/api/helpers";
import { readSapConnection } from "./config";
import { sapAttachmentDownload } from "./http";

// Supplied by the SAP team for Test. Never derive this from a browser URL or
// SAP_API_ENV: the matching/import workflow is explicitly SAP Test only.
const endpoint = "https://sbivan.samratgroup.com:5061/api/Grpo";
const maxBytes = 50 * 1024 * 1024;

export async function readBoundedAttachment(response: Response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError(
      response.status === 404
        ? "No attachments are available from the SAP GRPO download API."
        : `SAP attachment download failed (HTTP ${response.status}).`,
      response.status === 404 ? 404 : 502,
    );
  }
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new ApiError("SAP attachments exceed the 50 MB download limit.", 413);
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new ApiError("SAP returned an empty attachment archive.", 502);
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes)
        throw new ApiError(
          "SAP attachments exceed the 50 MB download limit.",
          413,
        );
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(parts);
}

export type DownloadedGrpoPdf = {
  name: string;
  bytes: Buffer;
  sha256: string;
};

/** In-memory ZIP reads only; never extract SAP-provided paths onto the server. */
export async function pdfsFromGrpoArchive(
  bytes: Buffer,
): Promise<DownloadedGrpoPdf[]> {
  if (bytes.length > maxBytes)
    throw new ApiError("SAP attachments exceed the 50 MB download limit.", 413);
  let zip: ZipFile | undefined;
  try {
    zip = await new Promise<ZipFile>((resolve, reject) =>
      fromBuffer(
        bytes,
        {
          lazyEntries: true,
          autoClose: false,
          validateEntrySizes: true,
          strictFileNames: true,
        },
        (error, result) => (error ? reject(error) : resolve(result!)),
      ),
    );
    const archive = zip;
    const entries = await new Promise<Entry[]>((resolve, reject) => {
      const pdfs: Entry[] = [];
      const names = new Set<string>();
      let seen = 0;
      let total = 0;
      archive.on("error", reject);
      archive.on("end", () => resolve(pdfs));
      archive.on("entry", (entry: Entry) => {
        try {
          if (++seen > 100)
            throw new ApiError(
              "SAP returned too many attachments in one archive.",
              413,
            );
          if (/\.pdf$/i.test(entry.fileName)) {
            const name = basename(entry.fileName);
            if (
              !name ||
              name.length > 240 ||
              /[\x00-\x1f\\]/.test(name) ||
              names.has(name.toLowerCase())
            )
              throw new ApiError(
                "SAP returned an invalid or ambiguous PDF filename.",
                502,
              );
            if (
              entry.isEncrypted() ||
              ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
            )
              throw new ApiError(
                "SAP returned an encrypted or linked PDF attachment.",
                502,
              );
            total += entry.uncompressedSize;
            if (
              !Number.isSafeInteger(total) ||
              total > maxBytes ||
              pdfs.length >= 20
            )
              throw new ApiError(
                "SAP PDFs exceed the 20 file / 50 MB packet limit.",
                413,
              );
            names.add(name.toLowerCase());
            pdfs.push(entry);
          }
          archive.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      archive.readEntry();
    });
    if (!entries.length)
      throw new ApiError(
        "No PDF is attached to this SAP GRPO. Report templates are not supplier PDFs.",
        404,
      );
    const files: DownloadedGrpoPdf[] = [];
    for (const entry of entries) {
      const stream = await new Promise<import("node:stream").Readable>(
        (resolve, reject) =>
          archive.openReadStream(entry, (error, result) =>
            error ? reject(error) : resolve(result!),
          ),
      );
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > maxBytes || size > entry.uncompressedSize) {
          stream.destroy();
          throw new ApiError("SAP PDF exceeds its declared size.", 413);
        }
        parts.push(chunk);
      }
      const pdf = Buffer.concat(parts);
      if (size !== entry.uncompressedSize || crc32(pdf) !== entry.crc32)
        throw new ApiError(
          "SAP returned a damaged PDF attachment. Retry the download.",
          502,
        );
      if (pdf.subarray(0, 5).toString() !== "%PDF-")
        throw new ApiError(
          "SAP did not return a PDF. No case was created.",
          502,
        );
      files.push({
        name: basename(entry.fileName),
        bytes: pdf,
        sha256: createHash("sha256").update(pdf).digest("hex"),
      });
    }
    return files.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "SAP returned an unreadable attachment archive. No case was created.",
      502,
    );
  } finally {
    zip?.close();
  }
}

export async function downloadGrpoPdfs(entry: number) {
  if (!Number.isSafeInteger(entry) || entry <= 0)
    throw new ApiError("Invalid SAP GRPO entry.");
  let connection;
  try {
    connection = readSapConnection("test");
  } catch {
    throw new ApiError(
      "SAP Test attachment API credentials are not configured.",
      503,
    );
  }
  try {
    const authorization = `Basic ${Buffer.from(`${connection.username}:${connection.password}`, "utf8").toString("base64")}`;
    const response = await sapAttachmentDownload(
      `${endpoint}/${entry}/download-attachments`,
      authorization,
    );
    return await pdfsFromGrpoArchive(await readBoundedAttachment(response));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "Could not download the SAP GRPO attachments. Retry shortly.",
      502,
    );
  }
}
