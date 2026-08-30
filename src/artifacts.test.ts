import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listArtifacts } from "./api.js";
import { extract, safeArtifactFilename } from "./archive.js";
import { ApiError, OctriClient } from "./client.js";

test("artifact downloads request authenticated direct delivery", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return new Response(JSON.stringify({ artifacts: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const client = new OctriClient(
      {
        profile: "test",
        apiUrl: "https://api.example.test/api/v1",
        accessToken: "token",
        refreshToken: undefined,
        apiKey: undefined,
        defaultProject: "project-1",
        defaultLanguages: [],
      },
      false,
    );
    await listArtifacts(client, "project-1", "build-1", true);
    assert.equal(
      requestedUrl,
      "https://api.example.test/api/v1/projects/project-1/sdk/builds/build-1/artifacts?delivery=direct",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("external artifact downloads never receive Octri credentials", async () => {
  const originalFetch = globalThis.fetch;
  let requestHeaders: unknown;
  globalThis.fetch = async (_input, init) => {
    requestHeaders = init?.headers;
    return new Response("artifact", { status: 200 });
  };

  try {
    const client = new OctriClient(
      {
        profile: "test",
        apiUrl: "https://api.example.test/api/v1",
        accessToken: "must-not-leak",
        refreshToken: undefined,
        apiKey: undefined,
        defaultProject: undefined,
        defaultLanguages: [],
      },
      false,
    );
    await client.fetchRaw("https://r2.example.test/presigned.zip?signature=ok");
    assert.deepEqual(requestHeaders, {});
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed presigned downloads redact their signed query", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("denied", { status: 403 });

  try {
    const client = new OctriClient(
      {
        profile: "test",
        apiUrl: "https://api.example.test/api/v1",
        accessToken: "must-not-leak",
        refreshToken: undefined,
        apiKey: undefined,
        defaultProject: undefined,
        defaultLanguages: [],
      },
      false,
    );
    await assert.rejects(
      client.fetchRaw(
        "https://r2.example.test/presigned.zip?signature=secret&token=private",
      ),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.path, "https://r2.example.test/presigned.zip");
        assert.doesNotMatch(error.path, /signature|token|secret|private/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed artifact errors never expose a presigned query", () => {
  const destination = mkdtempSync(join(tmpdir(), "octri-artifact-test-"));
  const url =
    "https://r2.example.test/downloads/sdk.zip?signature=secret&token=private";

  try {
    assert.throws(
      () =>
        extract(
          Buffer.from("not an archive"),
          destination,
          safeArtifactFilename(url),
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /sdk\.zip/);
        assert.doesNotMatch(error.message, /signature|token|secret|private/);
        return true;
      },
    );
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});
