import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "./args.js";
import { OctriClient } from "./client.js";
import { sdkRepoDisplay, sdkReposInit } from "./commands/sdk.js";
import { configureOutput } from "./ui/output.js";

import type { Context } from "./context.js";

test("nested SDK repository responses render their staging target", () => {
  assert.deepEqual(
    sdkRepoDisplay({
      langId: "typescript",
      staging: {
        owner: "octri-gh-test",
        repo: "sendgrid-sdk",
        branch: "staging",
        stagedAt: "2026-08-30T00:00:00.000Z",
        quality: { state: "passed" },
      },
      production: null,
    }),
    {
      repo: "octri-gh-test/sendgrid-sdk",
      branch: "staging",
      status: "passed",
      syncedAt: "2026-08-30T00:00:00.000Z",
    },
  );
});

test("sdk repos init sends explicit staging and production targets", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: unknown;
  let requestUrl = "";
  globalThis.fetch = async (input, init) => {
    requestUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (typeof init?.body !== "string") {
      throw new TypeError("Expected a JSON request body");
    }
    requestBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ repos: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  configureOutput({ json: false, quiet: true, plain: true });

  try {
    const args = parse([
      "sdk",
      "repos",
      "typescript",
      "--staging-owner",
      "octri-gh-test",
      "--staging-repo",
      "sendgrid-sdk",
      "--staging-branch",
      "staging",
      "--production-owner",
      "octri-gh-test",
      "--production-repo",
      "sendgrid-sdk",
      "--production-branch",
      "main",
    ]);
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

    await sdkReposInit(ctx);

    assert.equal(
      requestUrl,
      "https://api.example.test/api/v1/projects/project-1/sdk/repos/typescript/initialize",
    );
    assert.deepEqual(requestBody, {
      staging: {
        owner: "octri-gh-test",
        repo: "sendgrid-sdk",
        branch: "staging",
      },
      production: {
        owner: "octri-gh-test",
        repo: "sendgrid-sdk",
        branch: "main",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
