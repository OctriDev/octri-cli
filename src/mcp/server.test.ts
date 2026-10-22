import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { PROXY_VARIABLES } from "../proxy.js";
import { createServer } from "./server.js";

// Some tests below stub the built-in fetch. A proxy variable in the shell
// running them would send requests through undici instead and past the stub.
for (const name of PROXY_VARIABLES) delete process.env[name];

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

async function connect(
  options = { allowPublish: false, allowDelete: false },
): Promise<Client> {
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
    options,
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

// ─── Tools added in 1.0.7 ─────────────────────────────────────────────────────

const GATED = {
  publish: ["octri_publish_mcp_package", "octri_publish_docs_nav"],
  delete: ["octri_delete_component", "octri_delete_webhook"],
};

test("lists the new tools, and the irreversible ones only behind their flags", async () => {
  const names = async (options?: { allowPublish: boolean; allowDelete: boolean }) =>
    (await (await connect(options)).listTools()).tools.map((t) => t.name);

  const plain = await names();
  for (const name of [
    "octri_get_mcp_permissions",
    "octri_set_mcp_permission",
    "octri_set_redirects",
    "octri_set_nav_buttons",
    "octri_save_component",
    "octri_publish_draft_endpoints",
    "octri_create_webhook",
    "octri_import_conversion",
    "octri_set_quickstart",
    "octri_set_github_docs_sync",
    "octri_get_docs_nav",
    "octri_set_docs_nav",
    "octri_get_docs_settings",
    "octri_set_docs_settings",
    "octri_get_playground",
    "octri_set_playground",
    "octri_get_custom_code",
    "octri_set_custom_code",
  ]) {
    assert.ok(plain.includes(name), name);
  }
  for (const name of [...GATED.publish, ...GATED.delete]) {
    assert.ok(!plain.includes(name), `${name} listed without its flag`);
  }

  const all = await names({ allowPublish: true, allowDelete: true });
  for (const name of [...GATED.publish, ...GATED.delete]) assert.ok(all.includes(name), name);
  assert.equal(new Set(all).size, all.length, "tool names are unique");
});

test("refuses a gated tool called by name without its flag, before any request", async () => {
  const client = await connect();
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response("{}", { status: 200 });
  };
  try {
    const publish = await client.callTool({ name: "octri_publish_mcp_package", arguments: {} });
    assert.equal(publish.isError, true);
    assert.match(text(publish), /--allow-publish/);

    const remove = await client.callTool({
      name: "octri_delete_webhook",
      arguments: { webhook_id: "w1" },
    });
    assert.equal(remove.isError, true);
    assert.match(text(remove), /--allow-delete/);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("octri_set_mcp_permission publishes the merged map at the revision it read", async () => {
  const client = await connect();
  const original = globalThis.fetch;
  let put: unknown;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (init?.method === "PUT") {
      put = JSON.parse(String(init.body));
      return Response.json({ policies: {}, policiesRevision: 3 });
    }
    assert.match(url, /\/projects\/proj1\/mcp\/tools$/);
    return Response.json({
      tools: [{ slug: "post-refunds", name: "createRefund", http: { method: "POST", path: "/refunds" } }],
      policies: {},
      policiesRevision: 2,
    });
  };
  try {
    const result = await client.callTool({
      name: "octri_set_mcp_permission",
      arguments: { tool: "createRefund", policy: "confirm", destructive: true },
    });
    assert.equal(result.isError, undefined, text(result));
    assert.deepEqual(put, {
      policies: { "post-refunds": { policy: "confirm", destructive: true } },
      revision: 2,
    });
  } finally {
    globalThis.fetch = original;
  }
});

// ─── octri.json sections ──────────────────────────────────────────────────────

test("octri_set_docs_settings sends the camelCase patch and names theme keys the API dropped", async () => {
  const client = await connect();
  const original = globalThis.fetch;
  let patch: unknown;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    assert.match(url, /\/projects\/proj1$/);
    patch = JSON.parse(String(init?.body));
    // The API strips a theme key it does not know, as `primaryColour` here.
    return Response.json({
      project: { theme: { primaryColor: "#ff6a00" }, seo: {}, socials: {}, feedbackEnabled: true },
    });
  };
  try {
    const result = await client.callTool({
      name: "octri_set_docs_settings",
      arguments: {
        theme: { primaryColor: "#ff6a00", primaryColour: "#ff6a00" },
        feedback_enabled: true,
      },
    });
    assert.equal(result.isError, undefined, text(result));
    assert.deepEqual(patch, {
      theme: { primaryColor: "#ff6a00", primaryColour: "#ff6a00" },
      feedbackEnabled: true,
    });
    assert.deepEqual((JSON.parse(text(result)) as { ignored?: string[] }).ignored, [
      "theme.primaryColour",
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("octri_set_playground merges a partial default_auth onto the saved one", async () => {
  const client = await connect();
  const original = globalThis.fetch;
  let patch: unknown;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "PATCH") {
      patch = JSON.parse(String(init.body));
      return Response.json({ playground: {} });
    }
    return Response.json({
      playground: { defaultAuth: { type: "inherit", headerName: "X-Api-Key" } },
    });
  };
  try {
    const result = await client.callTool({
      name: "octri_set_playground",
      arguments: { default_auth: { type: "apiKey" }, allowed_origins: ["https://acme.com"] },
    });
    assert.equal(result.isError, undefined, text(result));
    assert.deepEqual(patch, {
      allowedOrigins: ["https://acme.com"],
      defaultAuth: { type: "apiKey", headerName: "X-Api-Key" },
    });
  } finally {
    globalThis.fetch = original;
  }
});
