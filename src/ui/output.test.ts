import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTimestamp } from "./output.js";

test("ISO 8601 with a zone parses as given", () => {
  assert.equal(
    parseTimestamp("2026-09-04T09:59:19.237Z"),
    Date.UTC(2026, 8, 4, 9, 59, 19, 237),
  );
});

test("ClickHouse's zoneless timestamp is read as UTC, not local", () => {
  // The bug this guards: Node parses `2026-09-04 09:59:19.237` as LOCAL time,
  // so on any host that is not UTC every monitoring timestamp was shifted.
  assert.equal(
    parseTimestamp("2026-09-04 09:59:19.237"),
    Date.UTC(2026, 8, 4, 9, 59, 19, 237),
  );
});

test("a zoneless value with a T separator is also UTC", () => {
  assert.equal(
    parseTimestamp("2026-09-04T09:59:19"),
    Date.UTC(2026, 8, 4, 9, 59, 19),
  );
});

test("an unparseable value stays NaN for the caller to fall back on", () => {
  assert.ok(Number.isNaN(parseTimestamp("not a date")));
});
