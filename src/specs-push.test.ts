import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse } from "./args.js";
import { OctriClient } from "./client.js";
import { specsPush } from "./commands/specs.js";
import { configureOutput } from "./ui/output.js";

import type { Context } from "./context.js";

test("specs push accepts the flat V1 ingestion response", async () => {
  const root = mkdtempSync(join(tmpdir(), "octri-cli-spec-push-"));
  const specPath = join(root, "openapi.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Fixture", version: "1" },
      paths: {},
    }),
  );
  const originalFetch = globalThis.fetch;
  let requestBody: unknown;
  globalThis.fetch = async (_input, init) => {
    if (typeof init?.body !== "string") {
      throw new TypeError("Expected a JSON request body");
    }
    requestBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        specId: "spec-1",
        version: "1.0.0",
        endpointCount: 0,
        jobs: [],
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  };
  configureOutput({ json: false, quiet: true, plain: true });

  try {
    const args = parse(["specs", "push", specPath, "--no-wait"]);
    const settings = {
      profile: "test",
      apiUrl: "https://api.example.test/api/v1",
      accessToken: "token",
      refreshToken: undefined,
      apiKey: undefined,
      defaultProject: "project-1",
      defaultLanguages: [],
    };
    const ctx: Context = {
      args,
      settings,
      client: new OctriClient(settings, false),
      projectId: () => "project-1",
    };

    await assert.doesNotReject(specsPush(ctx));
    assert.deepEqual(requestBody, {
      content: JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Fixture", version: "1" },
        paths: {},
      }),
    });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
