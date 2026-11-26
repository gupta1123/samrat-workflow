import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect, createServer as tcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import test from "node:test";
import {
  isSapStaticEgressConfigured,
  sapAttachmentDownload,
  sapFetch,
} from "../src/server/sap/http";
import { createInvoiceFtp } from "../src/server/ftp-inbox/transport";
import { readStaticEgressProxy } from "../src/server/static-egress";

test(
  "static gateway preserves reads and FTP transfers while enforcing TLS and authentication",
  { timeout: 30_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "samrat-egress-test-"));
    const variables = [
      "QUOTAGUARDSTATIC_URL",
      "STATIC_EGRESS_PROXY_URL",
      "STATIC_EGRESS_PROXY_CA_BASE64",
      "FTP_INBOX_HOST",
      "FTP_INBOX_PORT",
      "FTP_INBOX_USER",
      "FTP_INBOX_PASSWORD",
      "FTP_INBOX_ROOT",
      "FTP_INBOX_SECURITY",
      "FTP_INBOX_USE_STATIC_PROXY",
    ];
    const original = Object.fromEntries(
      variables.map((name) => [name, process.env[name]]),
    );
    const sockets = new Set<Duplex>();
    const servers: ReturnType<typeof tcpServer>[] = [];
    let targetReads = 0;
    let tunnels = 0;
    const track = (socket: Duplex) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    };
    const listen = async (server: ReturnType<typeof tcpServer>) => {
      servers.push(server);
      server.on("connection", track);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      return (server.address() as { port: number }).port;
    };
    for (const name of variables) delete process.env[name];
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:P-256",
          "-nodes",
          "-keyout",
          join(directory, "key.pem"),
          "-out",
          join(directory, "cert.pem"),
          "-days",
          "2",
          "-subj",
          "/CN=Temporary gateway integration test",
          "-addext",
          "subjectAltName=IP:127.0.0.1,DNS:localhost",
        ],
        { stdio: "ignore" },
      );
      const cert = readFileSync(join(directory, "cert.pem"));
      const key = readFileSync(join(directory, "key.pem"));
      const bytes = Buffer.from("%PDF-1.4\nTest invoice bytes\n%%EOF");
      const origin = httpServer((_request, response) => {
        targetReads++;
        response.end(bytes);
      });
      const originPort = await listen(origin);
      const allowed = new Set<number>([originPort]);
      const tlsProxy = httpsServer({ cert, key });
      const oldProxy = httpServer();
      for (const proxy of [tlsProxy, oldProxy]) {
        proxy.on("connect", (request, client, head) => {
          track(client);
          if (
            request.headers["proxy-authorization"] !==
            `Basic ${Buffer.from("test:secret").toString("base64")}`
          ) {
            client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
            return;
          }
          const [host, rawPort] = request.url!.split(":");
          if (host !== "127.0.0.1" || !allowed.has(Number(rawPort))) {
            client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
            return;
          }
          tunnels++;
          const upstream = connect(Number(rawPort), host, () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            client.pipe(upstream).pipe(client);
          });
          track(upstream);
          client.on("close", () => upstream.destroy());
          upstream.on("close", () => client.destroy());
        });
        proxy.on("tlsClientError", () => {});
      }
      const tlsPort = await listen(tlsProxy);
      const oldPort = await listen(oldProxy);
      const originUrl = `http://127.0.0.1:${originPort}/invoice.pdf`;
      const gatewayUrl = `https://test:secret@127.0.0.1:${tlsPort}`;

      await t.test(
        "direct reads and the existing HTTP provider still work",
        async () => {
          assert.equal(isSapStaticEgressConfigured(), false);
          assert.deepEqual(
            Buffer.from(await (await sapFetch(originUrl)).arrayBuffer()),
            bytes,
          );
          assert.equal(tunnels, 0);
          process.env.QUOTAGUARDSTATIC_URL = `http://test:secret@127.0.0.1:${oldPort}`;
          assert.deepEqual(
            Buffer.from(await (await sapFetch(originUrl)).arrayBuffer()),
            bytes,
          );
          assert.equal(tunnels, 1);
        },
      );
      await t.test(
        "the verified replacement overrides the old provider for SAP reads and attachments",
        async () => {
          process.env.QUOTAGUARDSTATIC_URL = "http://unused:unused@127.0.0.1:1";
          process.env.STATIC_EGRESS_PROXY_URL = gatewayUrl;
          process.env.STATIC_EGRESS_PROXY_CA_BASE64 = cert.toString("base64");
          assert.deepEqual(
            Buffer.from(await (await sapFetch(originUrl)).arrayBuffer()),
            bytes,
          );
          assert.deepEqual(
            Buffer.from(
              await (
                await sapAttachmentDownload(originUrl, "Bearer test")
              ).arrayBuffer(),
            ),
            bytes,
          );
        },
      );
      await t.test(
        "an untrusted certificate or rejected login never falls back to direct access",
        async () => {
          const before = targetReads;
          delete process.env.STATIC_EGRESS_PROXY_CA_BASE64;
          await assert.rejects(async () =>
            (await sapFetch(originUrl)).arrayBuffer(),
          );
          process.env.STATIC_EGRESS_PROXY_CA_BASE64 = cert.toString("base64");
          process.env.STATIC_EGRESS_PROXY_URL = gatewayUrl.replace(
            ":secret@",
            ":incorrect@",
          );
          await assert.rejects(async () =>
            (await sapFetch(originUrl)).arrayBuffer(),
          );
          assert.equal(targetReads, before);
          process.env.STATIC_EGRESS_PROXY_URL = gatewayUrl;
        },
      );

      const renames: string[] = [];
      const ftp = tcpServer((socket) => {
        socket.setEncoding("utf8");
        socket.write("220 Test FTP ready\r\n");
        let pending = "";
        let dataConnection: Promise<Socket> | null = null;
        socket.on("data", (data) => {
          pending += data;
          while (pending.includes("\r\n")) {
            const end = pending.indexOf("\r\n");
            const command = pending.slice(0, end);
            pending = pending.slice(end + 2);
            const verb = command.split(" ")[0].toUpperCase();
            if (verb === "USER") socket.write("331 Password required\r\n");
            else if (verb === "PASS") socket.write("230 Logged in\r\n");
            else if (verb === "PWD") socket.write('257 "/"\r\n');
            else if (verb === "CWD" || verb === "TYPE")
              socket.write("200 OK\r\n");
            else if (verb === "SYST") socket.write("215 UNIX Type: L8\r\n");
            else if (verb === "EPSV") {
              const passive = tcpServer();
              dataConnection = new Promise<Socket>((resolve) =>
                passive.once("connection", resolve),
              );
              void listen(passive).then((port) => {
                allowed.add(port);
                socket.write(
                  `229 Entering Extended Passive Mode (|||${port}|)\r\n`,
                );
              });
            } else if (verb === "LIST" || verb === "RETR") {
              socket.write("150 Opening data connection\r\n");
              void dataConnection!.then((dataSocket) => {
                const payload =
                  verb === "LIST"
                    ? Buffer.from(
                        `-rw-r--r-- 1 test test ${bytes.length} Nov 26 10:00 invoice.pdf\r\n`,
                      )
                    : bytes;
                dataSocket.end(payload, () =>
                  socket.write("226 Transfer complete\r\n"),
                );
              });
            } else if (verb === "SIZE") socket.write(`213 ${bytes.length}\r\n`);
            else if (verb === "RNFR") {
              renames.push(command);
              socket.write("350 Rename target required\r\n");
            } else if (verb === "RNTO") {
              renames.push(command);
              socket.write("250 Renamed\r\n");
            } else if (verb === "QUIT") socket.end("221 Goodbye\r\n");
            else socket.write("502 Command unsupported\r\n");
          }
        });
      });
      const ftpPort = await listen(ftp);
      allowed.add(ftpPort);
      Object.assign(process.env, {
        FTP_INBOX_HOST: "127.0.0.1",
        FTP_INBOX_PORT: String(ftpPort),
        FTP_INBOX_USER: "fixture",
        FTP_INBOX_PASSWORD: "fixture",
        FTP_INBOX_ROOT: "/prod",
        FTP_INBOX_SECURITY: "ftp",
        FTP_INBOX_USE_STATIC_PROXY: "true",
      });
      await t.test(
        "FTP listing, download and archive use authenticated TLS control and passive-data tunnels",
        async () => {
          const before = tunnels;
          const client = createInvoiceFtp();
          const files = await client.list("in");
          assert.equal(files.length, 1);
          assert.equal(files[0].name, "invoice.pdf");
          assert.equal(files[0].size, bytes.length);
          assert.deepEqual(await client.download("in", "invoice.pdf"), bytes);
          await client.archive("invoice.pdf", "archived.pdf");
          assert.deepEqual(renames, [
            "RNFR /prod/in/invoice.pdf",
            "RNTO /prod/archive/archived.pdf",
          ]);
          assert.ok(
            tunnels - before >= 6,
            "Both FTP control and data connections must use the gateway",
          );
        },
      );
      await t.test(
        "untrusted FTP TLS and malformed configuration fail closed without leaking credentials",
        async () => {
          delete process.env.STATIC_EGRESS_PROXY_CA_BASE64;
          const before = tunnels;
          await assert.rejects(
            createInvoiceFtp().download("in", "invoice.pdf"),
          );
          assert.equal(tunnels, before);
          process.env.STATIC_EGRESS_PROXY_URL =
            "http://test:private-secret@127.0.0.1:80";
          assert.throws(
            readStaticEgressProxy,
            /secure connection settings are invalid/,
          );
          process.env.STATIC_EGRESS_PROXY_URL = gatewayUrl;
          process.env.STATIC_EGRESS_PROXY_CA_BASE64 = "invalid";
          assert.throws(
            readStaticEgressProxy,
            /secure connection certificate is invalid/,
          );
        },
      );
    } finally {
      for (const name of variables) {
        if (original[name] === undefined) delete process.env[name];
        else process.env[name] = original[name];
      }
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
