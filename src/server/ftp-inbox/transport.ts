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

export class InboxFtpError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

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

  function run(extra: string[], maxBuffer: number, seconds = 28) {
    return new Promise<Buffer>((resolve, reject) => {
      const child = execFile(
        "curl",
        [...args, "--max-time", String(seconds), ...extra],
        { encoding: "buffer", timeout: (seconds + 2) * 1_000, maxBuffer },
        (error, stdout) => {
          if (!error) return resolve(stdout);
          const message =
            error.code === 9
              ? "The FTP account cannot open the configured folder."
              : error.code === 67
                ? "FTP sign-in was rejected."
                : "The FTP server did not complete the request. The worker will retry.";
          const retryable =
            typeof error.code === "number" &&
            [7, 18, 28, 55, 56].includes(error.code);
          reject(new InboxFtpError(message, retryable));
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(config + "\n");
    });
  }

  async function read(
    extra: string[],
    maxBuffer: number,
    seconds: number,
    attempts: number,
  ): Promise<Buffer> {
    // The server opens a separate connection for each data transfer. Retry a
    // failed read using a fresh connection and alternate the passive commands.
    for (let attempt = 1; ; attempt++) {
      try {
        return await run(
          attempt === 2 ? ["--disable-epsv", ...extra] : extra,
          maxBuffer,
          seconds,
        );
      } catch (error) {
        if (
          attempt === attempts ||
          !(error instanceof InboxFtpError) ||
          !error.retryable
        )
          throw error;
      }
    }
  }

  function checkedPath(folder: "in" | "archive", name: string) {
    if (!isInvoiceFilename(name))
      throw new InboxFtpError("Invalid FTP PDF filename.");
    return remote(folder, name);
  }

  return {
    async list(folder) {
      const listing = (
        await read([url(remote(folder) + "/")], 4 * 1024 * 1024, 10, 3)
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
      return read(
        [
          "--max-filesize",
          String(UPLOAD_LIMITS.bytes),
          url(checkedPath(folder, name)),
        ],
        UPLOAD_LIMITS.bytes,
        28,
        2,
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
