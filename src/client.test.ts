import assert from "node:assert/strict";
import { test } from "node:test";

import { cookieFrom, sessionCookieFrom } from "./client.js";
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

// Production names the session cookies `__Host-…` so a sibling *.octri.dev site
// cannot plant them; local development and older APIs use the bare names. The
// CLI has to sign in against all three.
test("reads the __Host- session cookies, and the bare ones as a fallback", () => {
  const prefixed = responseWith([
    "__Host-access_token=new.jwt; Path=/; Secure; HttpOnly",
    "__Host-refresh_token=new-refresh; Path=/; Secure; HttpOnly",
    "access_token=new.jwt; Path=/; Secure; HttpOnly",
  ]);
  assert.equal(sessionCookieFrom(prefixed, "access"), "new.jwt");
  assert.equal(sessionCookieFrom(prefixed, "refresh"), "new-refresh");

  const bare = responseWith(["access_token=old.jwt; Path=/", "refresh_token=old-refresh; Path=/"]);
  assert.equal(sessionCookieFrom(bare, "access"), "old.jwt");
  assert.equal(sessionCookieFrom(bare, "refresh"), "old-refresh");
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
