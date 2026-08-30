import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parse } from "./args.js";
import { OctriClient } from "./client.js";
import { authLogin } from "./commands/auth.js";
import { readConfig, writeConfig } from "./config.js";
import { configureOutput } from "./ui/output.js";

import type { Context } from "./context.js";

test("auth login persists credentials only to the selected profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "octri-cli-auth-profile-"));
  const previousConfigDir = process.env.OCTRI_CONFIG_DIR;
  const originalFetch = globalThis.fetch;
  process.env.OCTRI_CONFIG_DIR = root;
  writeConfig({
    version: 1,
    current: "default",
    profiles: {
      default: { apiUrl: "https://default.example/api/v1" },
      e2e: { apiUrl: "https://e2e.example/api/v1" },
    },
  });
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        user: { id: "user-1", email: "tester@example.com" },
        org: {
          id: "org-1",
          name: "Test Org",
          plan: "growth",
          billingStatus: "active",
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie":
            "access_token=e2e-access; Path=/, refresh_token=e2e-refresh; Path=/",
        },
      },
    );
  configureOutput({ json: false, quiet: true, plain: true });

  try {
    const args = parse([
      "auth",
      "login",
      "--profile",
      "e2e",
      "--email",
      "tester@example.com",
      "--password",
      "password",
    ]);
    const settings = {
      profile: "e2e",
      apiUrl: "https://e2e.example/api/v1",
      accessToken: undefined,
      refreshToken: undefined,
      apiKey: undefined,
      defaultProject: undefined,
      defaultLanguages: [],
    };
    const ctx: Context = {
      args,
      settings,
      client: new OctriClient(settings),
      projectId: () => {
        throw new Error("not used");
      },
    };

    await authLogin(ctx);

    const config = readConfig();
    assert.equal(config.current, "e2e");
    assert.equal(config.profiles.e2e?.accessToken, "e2e-access");
    assert.equal(config.profiles.e2e?.refreshToken, "e2e-refresh");
    assert.equal(config.profiles.default?.accessToken, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousConfigDir === undefined) delete process.env.OCTRI_CONFIG_DIR;
    else process.env.OCTRI_CONFIG_DIR = previousConfigDir;
    rmSync(root, { recursive: true, force: true });
  }
});
