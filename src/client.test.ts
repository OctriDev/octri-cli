import assert from "node:assert/strict";
import { test } from "node:test";

import { cookieFrom } from "./client.js";
import { normalizeApiUrl } from "./config.js";

function responseWith(cookies: readonly string[]): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { headers });
}

test("reads the session cookies login returns", () => {
  const response = responseWith([
    "access_token=abc.def; Path=/; HttpOnly; SameSite=Lax",
    "refresh_token=xyz; Path=/; HttpOnly; Max-Age=2592000",
  ]);

  assert.equal(cookieFrom(response, "access_token"), "abc.def");
  assert.equal(cookieFrom(response, "refresh_token"), "xyz");
  assert.equal(cookieFrom(response, "missing"), undefined);
});

test("a cookie whose attributes contain commas still parses", () => {
  const response = responseWith([
    "access_token=tok; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
  ]);
  assert.equal(cookieFrom(response, "access_token"), "tok");
});

test("normalizeApiUrl always yields an /api/v1 root", () => {
  assert.equal(normalizeApiUrl("local"), "http://localhost:3001/api/v1");
  assert.equal(normalizeApiUrl("api.octri.dev"), "https://api.octri.dev/api/v1");
  assert.equal(
    normalizeApiUrl("http://127.0.0.1:4010/"),
    "http://127.0.0.1:4010/api/v1",
  );
  assert.equal(
    normalizeApiUrl("https://api.octri.dev/api/v1"),
    "https://api.octri.dev/api/v1",
  );
});
