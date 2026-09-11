import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeApiUrl, readConfig, useProfile } from "./config.js";

// ─── Transport ────────────────────────────────────────────────────────────────

test("plaintext HTTP to a remote host is refused", () => {
  assert.throws(
    () => normalizeApiUrl("http://api.octri.dev"),
    /plaintext HTTP/,
  );
});

test("plaintext HTTP to this machine stays allowed", () => {
  assert.equal(normalizeApiUrl("http://localhost:3001"), "http://localhost:3001/api/v1");
  assert.equal(normalizeApiUrl("http://127.0.0.1:4010/"), "http://127.0.0.1:4010/api/v1");
});

test("an explicit opt-in re-enables plaintext HTTP", () => {
  const previous = process.env.OCTRI_ALLOW_INSECURE_HTTP;
  process.env.OCTRI_ALLOW_INSECURE_HTTP = "1";
  try {
    assert.equal(
      normalizeApiUrl("http://internal.proxy"),
      "http://internal.proxy/api/v1",
    );
  } finally {
    if (previous === undefined) delete process.env.OCTRI_ALLOW_INSECURE_HTTP;
    else process.env.OCTRI_ALLOW_INSECURE_HTTP = previous;
  }
});

// ─── Profile names ────────────────────────────────────────────────────────────

test("a __proto__ key in the config file never becomes a profile", () => {
  const root = mkdtempSync(join(tmpdir(), "octri-cli-proto-"));
  const previous = process.env.OCTRI_CONFIG_DIR;
  process.env.OCTRI_CONFIG_DIR = root;
  try {
    // Written as text: an object literal would set the prototype instead of
    // giving us the own "__proto__" key a hostile file would actually carry.
    writeFileSync(
      join(root, "config.json"),
      `{"version":1,"current":"default","profiles":{` +
        `"default":{"apiUrl":"https://api.octri.dev/api/v1"},` +
        `"__proto__":{"apiUrl":"https://evil.test/api/v1"}}}`,
    );

    const config = readConfig();

    assert.deepEqual(Object.keys(config.profiles), ["default"]);
    assert.equal(Object.getPrototypeOf(config.profiles), null);
  } finally {
    if (previous === undefined) delete process.env.OCTRI_CONFIG_DIR;
    else process.env.OCTRI_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("selecting a reserved profile name fails instead of writing to a prototype", () => {
  assert.throws(() => useProfile("__proto__"), /not a usable profile name/);
});
