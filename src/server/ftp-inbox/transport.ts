import { execFile } from "node:child_process";
import { parseList } from "basic-ftp";
import { UPLOAD_LIMITS } from "@/server/uploads";

export type RemoteInvoice = {
  name: string;
  size: number;
  modifiedAt: string | null;
};

export type InvoiceFtp = {
  list: (folder: "in" | "archive") => Promise<RemoteInvoice[]>;
  download: (folder: "in" | "archive", name: string) => Promise<Buffer>;
  archive: (name: string, archiveName: string) => Promise<void>;
};

export class InboxFtpError extends Error {}

export function isInvoiceFilename(name: string) {
  return (
    /^.{1,220}\.pdf$/iu.test(name) &&
    !/[\\/\u0000-\u001f\u007f]/u.test(name) &&
    !name.startsWith(".")
  );
}

export function sameRemoteFile(left: RemoteInvoice, right: RemoteInvoice) {
  return (
    left.name === right.name &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt
  );
}

export function archiveFilename(name: string, id: string) {
  return `${Array.from(name.slice(0, -4)).slice(0, 166).join("")}-${id}.pdf`;
}

export function createInvoiceFtp(): InvoiceFtp {
  const host = process.env.FTP_INBOX_HOST?.trim() ?? "";
  const user = process.env.FTP_INBOX_USER ?? "";
  const password = process.env.FTP_INBOX_PASSWORD ?? "";
  const mode = process.env.FTP_INBOX_SECURITY ?? "ftps";
  const root = process.env.FTP_INBOX_ROOT?.trim().replace(/\/+$/, "") ?? "";
  const port = Number(process.env.FTP_INBOX_PORT ?? 21);
  if (
    !/^[a-z0-9][a-z0-9.-]*$/i.test(host) ||
    !user ||
    !password ||
    /[\r\n\0]/.test(user + password + root) ||
    root.split("/").some((segment) => segment === "." || segment === "..") ||
    !["ftps", "ftp"].includes(mode) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new InboxFtpError("FTP connection settings are incomplete.");

  const proxy =
    process.env.FTP_INBOX_USE_STATIC_PROXY === "true"
      ? new URL(process.env.QUOTAGUARDSTATIC_URL ?? "")
      : null;
  const args = [
    "-q",
    "--config",
    "-",
    "--silent",
    "--show-error",
    "--proto",
    "=ftp,ftps",
    "--connect-timeout",
    "8",
    "--max-time",
    "28",
    "--ftp-skip-pasv-ip",
    "--proxy",
    proxy ? `socks5h://${proxy.hostname}:1080` : "",
    "--noproxy",
    "",
    ...(mode === "ftps" ? ["--ssl-reqd"] : []),
  ];
  const config = [
    `user = ${JSON.stringify(`${user}:${password}`)}`,
    ...(proxy
      ? [
          `proxy-user = ${JSON.stringify(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`)}`,
        ]
      : []),
  ].join("\n");
  const remote = (folder: "in" | "archive", name = "") =>
    [root, folder, name].filter(Boolean).join("/");
  const url = (path = "") =>
    `ftp://${host}:${port}/${path.split("/").map(encodeURIComponent).join("/").replace(/^\//, "%2F")}`;

  function run(extra: string[], maxBuffer: number) {
    return new Promise<Buffer>((resolve, reject) => {
      const child = execFile(
        "curl",
        [...args, ...extra],
        { encoding: "buffer", timeout: 30_000, maxBuffer },
        (error, stdout) => {
          if (!error) return resolve(stdout);
          const message =
            error.code === 9
              ? "The FTP account cannot open the configured folder."
              : error.code === 67
                ? "FTP sign-in was rejected."
                : "The FTP server did not complete the request. The worker will retry.";
          reject(new InboxFtpError(message));
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(config + "\n");
    });
  }

  function checkedPath(folder: "in" | "archive", name: string) {
    if (!isInvoiceFilename(name))
      throw new InboxFtpError("Invalid FTP PDF filename.");
    return remote(folder, name);
  }

  return {
    async list(folder) {
      const listing = (
        await run([url(remote(folder) + "/")], 4 * 1024 * 1024)
      ).toString("utf8");
      const parsed = parseList(listing);
      if (
        listing.trim() &&
        !parsed.length &&
        !/^total\s+0\s*$/i.test(listing.trim())
      )
        throw new InboxFtpError("The FTP folder listing could not be read.");
      return parsed
        .filter(
          (entry) =>
            entry.isFile &&
            isInvoiceFilename(entry.name) &&
            Number.isSafeInteger(entry.size) &&
            entry.size >= 0,
        )
        .map((entry) => ({
          name: entry.name,
          size: entry.size,
          modifiedAt:
            entry.modifiedAt?.toISOString() ?? (entry.rawModifiedAt || null),
        }));
    },
    download(folder, name) {
      return run(
        [
          "--max-filesize",
          String(UPLOAD_LIMITS.bytes),
          url(checkedPath(folder, name)),
        ],
        UPLOAD_LIMITS.bytes,
      );
    },
    async archive(name, archiveName) {
      const from = checkedPath("in", name);
      const to = checkedPath("archive", archiveName);
      await run(
        ["--head", "--quote", `RNFR ${from}`, "--quote", `RNTO ${to}`, url()],
        64 * 1024,
      );
    },
  };
}
