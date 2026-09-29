import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "./server.js";

// ─── Local artifact cache ─────────────────────────────────────────────────────
//
// The generated-file tools take `project_id`, `build_id` and `language` from an
// agent, and an agent can be steered by text it read. Joined into a path
// unchecked, `build_id: "../../.."` listed and read anything the user could,
// including ~/.octri/config.json with the session and API key.

const configDir = mkdtempSync(join(tmpdir(), "octri-mcp-"));
process.env.OCTRI_CONFIG_DIR = configDir;
test.after(() => rmSync(configDir, { recursive: true, force: true }));

writeFileSync(join(configDir, "config.json"), '{"secret":"session-and-api-key"}');
const generated = join(configDir, "cache", "lab", "proj1", "build1", "typescript", "src");
mkdirSync(generated, { recursive: true });
writeFileSync(join(generated, "index.ts"), "export const ok = true;\n");

async function connect(): Promise<Client> {
  const server = createServer(
    {
      profile: "default",
      apiUrl: "https://api.example.com/api/v1",
      accessToken: undefined,
      refreshToken: undefined,
      apiKey: "test-key",
      defaultProject: "proj1",
      defaultLanguages: [],
    },
    { allowPublish: false, allowDelete: false },
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = Array.isArray(result.content) ? result.content : [];
  return typeof first === "object" && first !== null && "text" in first ? String(first.text) : "";
}

test("lists and reads a fetched build's files", async () => {
  const client = await connect();
  const listed = await client.callTool({
    name: "octri_list_generated_files",
    arguments: { project_id: "proj1", build_id: "build1", language: "typescript" },
  });
  assert.equal(listed.isError, undefined);
  assert.match(text(listed), /src\/index\.ts/);

  const read = await client.callTool({
    name: "octri_read_generated_file",
    arguments: { project_id: "proj1", build_id: "build1", language: "typescript", path: "src/index.ts" },
  });
  assert.match(text(read), /export const ok/);
});

for (const [what, args] of [
  ["build_id", { project_id: "proj1", build_id: "../../..", language: "." }],
  ["project_id", { project_id: "../..", build_id: "build1", language: "typescript" }],
  ["language", { project_id: "proj1", build_id: "build1", language: "../../../.." }],
] as const) {
  test(`refuses to walk out of the cache through ${what}`, async () => {
    const client = await connect();
    for (const name of ["octri_list_generated_files", "octri_read_generated_file"]) {
      const result = await client.callTool({ name, arguments: { ...args, path: "config.json" } });
      assert.equal(result.isError, true, name);
      assert.doesNotMatch(text(result), /session-and-api-key|config\.json"/, name);
      assert.match(text(result), new RegExp(`Invalid ${what}`), name);
    }
  });
}
