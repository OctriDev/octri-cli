import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { X509Certificate, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// These tests run the built CLI as a child process with only the variables each
// one is about, so nothing (NODE_USE_ENV_PROXY included) leaks in from the shell.
const BIN = fileURLToPath(new URL("./bin.js", import.meta.url));

// A reserved TLD: the only way to reach this host is through the proxy, which
// sends every tunnel to the local API below.
const PROXIED_HOST = "api.octri.test";

const { key, cert } = selfSignedCertificate();
const workDir = mkdtempSync(join(tmpdir(), "octri-cli-proxy-"));
const caFile = join(workDir, "ca.pem");
writeFileSync(caFile, cert);

const apiRequests: string[] = [];
const api = createHttpsServer({ key, cert }, (req, res) => {
  apiRequests.push(`${req.method} ${req.url}`);
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      projects: [{ id: "p1", name: "Proxied", createdAt: "2026-01-01T00:00:00.000Z" }],
    }),
  );
});

const proxyHits: string[] = [];
const tunnels = new Set<Duplex>();
let proxyRefuses = false;
const proxy = createHttpServer((req, res) => {
  proxyHits.push(`${req.method} ${req.url}`);
  res.writeHead(502).end();
});
proxy.on("connect", (req, client: Duplex, head: Buffer) => {
  proxyHits.push(`CONNECT ${req.url}`);
  tunnels.add(client);
  if (proxyRefuses) {
    client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    return;
  }
  const upstream = connect(port(api), "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  tunnels.add(upstream);
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});

await listen(api);
await listen(proxy);
// Older test runners only call a root after() once the event loop drains, which
// these servers would otherwise prevent.
api.unref();
proxy.unref();

test.after(() => {
  for (const socket of tunnels) socket.destroy();
  api.closeAllConnections();
  proxy.closeAllConnections();
  api.close();
  proxy.close();
  rmSync(workDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  apiRequests.length = 0;
  proxyHits.length = 0;
  proxyRefuses = false;
});

for (const variable of ["HTTPS_PROXY", "https_proxy"]) {
  test(`the CLI tunnels through ${variable} with no extra flag`, { timeout: 20_000 }, async () => {
    const run = await octri(["projects", "list", "--json"], {
      [variable]: proxyUrl(),
      OCTRI_API_URL: `https://${PROXIED_HOST}`,
    });

    assert.equal(run.code, 0, run.stderr);
    const body: { projects: { name: string }[] } = JSON.parse(run.stdout);
    assert.equal(body.projects[0]?.name, "Proxied");
    assert.deepEqual(proxyHits, [`CONNECT ${PROXIED_HOST}:443`]);
    assert.deepEqual(apiRequests, ["GET /api/v1/projects"]);
  });
}

for (const variable of ["NO_PROXY", "no_proxy"]) {
  test(`hosts in ${variable} skip the proxy`, { timeout: 20_000 }, async () => {
    const run = await octri(["projects", "list", "--json"], {
      HTTPS_PROXY: proxyUrl(),
      [variable]: "localhost,127.0.0.1",
      OCTRI_API_URL: `https://127.0.0.1:${port(api)}`,
    });

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(proxyHits, []);
    assert.deepEqual(apiRequests, ["GET /api/v1/projects"]);
  });
}

test("with no proxy variable the CLI connects directly", { timeout: 20_000 }, async () => {
  const run = await octri(["projects", "list", "--json"], {
    OCTRI_API_URL: `https://127.0.0.1:${port(api)}`,
  });

  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(proxyHits, []);
  assert.deepEqual(apiRequests, ["GET /api/v1/projects"]);
});

test("a proxy that refuses the tunnel is named in the error", { timeout: 20_000 }, async () => {
  proxyRefuses = true;
  const run = await octri(["projects", "list", "--json"], {
    HTTPS_PROXY: proxyUrl(),
    OCTRI_API_URL: `https://${PROXIED_HOST}`,
  });

  assert.equal(run.code, 1);
  assert.match(run.stdout + run.stderr, /Proxy response \(407\)/);
  assert.deepEqual(apiRequests, []);
});

test("the MCP server tunnels through HTTPS_PROXY too", { timeout: 20_000 }, async () => {
  const client = new Client({ name: "proxy-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [BIN, "mcp", "serve"],
      env: { ...baseEnv(), HTTPS_PROXY: proxyUrl(), OCTRI_API_URL: `https://${PROXIED_HOST}` },
      stderr: "ignore",
    }),
  );

  try {
    const result = await client.callTool({ name: "octri_list_projects", arguments: {} });
    assert.equal(result.isError, undefined);
    assert.match(text(result), /Proxied/);
    assert.deepEqual(proxyHits, [`CONNECT ${PROXIED_HOST}:443`]);
  } finally {
    await client.close();
  }
});

test("every request goes through fetchWithProxy", () => {
  // A bare fetch() would ignore the proxy variables again.
  const dist = fileURLToPath(new URL(".", import.meta.url));
  const offenders = readdirSync(dist, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".js") && !file.endsWith(".test.js") && file !== "proxy.js")
    .filter((file) => /(?<![\w.])fetch\(/.test(readFileSync(join(dist, file), "utf8")));

  assert.deepEqual(offenders, []);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function octri(args: string[], env: Record<string, string>): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...baseEnv(), ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** What every run gets: credentials, an empty config dir, and trust in the test cert. */
function baseEnv(): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "",
    OCTRI_CONFIG_DIR: workDir,
    OCTRI_API_KEY: "test-key",
    NODE_EXTRA_CA_CERTS: caFile,
  };
}

function proxyUrl(): string {
  return `http://127.0.0.1:${port(proxy)}`;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function port(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server is not listening on a TCP port.");
  }
  return address.port;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = Array.isArray(result.content) ? result.content : [];
  return typeof first === "object" && first !== null && "text" in first ? String(first.text) : "";
}

/**
 * A throwaway self-signed certificate for api.octri.test and 127.0.0.1, built in
 * memory so no private key is committed. The CLI trusts it through
 * NODE_EXTRA_CA_CERTS, the way a CI runner trusts a corporate CA.
 */
function selfSignedCertificate(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ecdsaWithSha256 = der(0x30, Buffer.from("06082a8648ce3d040302", "hex"));
  const name = der(
    0x30,
    der(0x31, der(0x30, Buffer.from("0603550403", "hex"), der(0x0c, Buffer.from("octri-cli test")))),
  );
  const subjectAltName = der(
    0x30,
    Buffer.from("0603551d11", "hex"),
    der(
      0x04,
      der(0x30, der(0x82, Buffer.from(PROXIED_HOST)), der(0x87, Buffer.from([127, 0, 0, 1]))),
    ),
  );
  const now = Date.now();
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))), // X.509 v3
    der(0x02, Buffer.from([1])), // serial number
    ecdsaWithSha256,
    name, // issuer: itself
    der(0x30, utcTime(now - 3_600_000), utcTime(now + 86_400_000)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, der(0x30, subjectAltName)),
  );
  const signature = Buffer.concat([Buffer.from([0]), sign("sha256", tbs, privateKey)]);

  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: new X509Certificate(der(0x30, tbs, ecdsaWithSha256, der(0x03, signature))).toString(),
  };
}

/** One DER element: tag, definite length, contents. */
function der(tag: number, ...contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  const length =
    body.length < 0x80
      ? [body.length]
      : body.length < 0x100
        ? [0x81, body.length]
        : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

/** ASN.1 UTCTime, YYMMDDHHMMSSZ. */
function utcTime(ms: number): Buffer {
  const digits = new Date(ms).toISOString().slice(2, 19).replace(/[-T:]/g, "");
  return der(0x17, Buffer.from(`${digits}Z`));
}
