import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "./mcp/server.js";
import { CLI_VERSION } from "./version.js";

const manifestVersion = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

test("CLI_VERSION is the manifest version", () => {
  assert.equal(CLI_VERSION, manifestVersion);
});

test("the MCP server reports the manifest version in its handshake", async () => {
  const server = createServer(
    {
      profile: "default",
      apiUrl: "https://api.example/api/v1",
      accessToken: undefined,
      refreshToken: undefined,
      apiKey: undefined,
      defaultProject: undefined,
      defaultLanguages: [],
    },
    { allowPublish: false, allowDelete: false },
  );
  const client = new Client({ name: "version-test", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    assert.deepEqual(client.getServerVersion(), {
      name: "octri-cli",
      version: manifestVersion,
    });
  } finally {
    await client.close();
  }
});
