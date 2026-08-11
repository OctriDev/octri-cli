import assert from "node:assert/strict";
import { test } from "node:test";

import { flagList, flagNumber, flagString, parse } from "./args.js";

test("splits the command path from positionals", () => {
  const args = parse(["sdk", "build", "b-123"]);
  assert.deepEqual(args.command, ["sdk", "build"]);
  assert.deepEqual(args.positionals, ["b-123"]);
});

test("a single-word command still parses", () => {
  const args = parse(["projects"]);
  assert.deepEqual(args.command, ["projects"]);
  assert.deepEqual(args.positionals, []);
});

test("--flag=value and --flag value are equivalent", () => {
  assert.equal(flagString(parse(["a", "--lang=go"]), "lang"), "go");
  assert.equal(flagString(parse(["a", "--lang", "go"]), "lang"), "go");
});

test("known boolean flags never swallow the next token", () => {
  const args = parse(["sdk", "watch", "--watch", "b-1"]);
  assert.equal(args.flags["watch"], true);
  assert.deepEqual(args.positionals, ["b-1"]);
});

test("--no-<flag> sets false so `--no-watch` can disable a default", () => {
  assert.equal(parse(["sdk", "build", "--no-watch"]).flags["watch"], false);
});

test("clustered short flags expand, and only the last takes a value", () => {
  const args = parse(["sdk", "build", "-jl", "go"]);
  assert.equal(args.flags["json"], true);
  assert.equal(args.flags["lang"], "go");
  assert.deepEqual(args.positionals, []);
});

test("everything after -- is passed through untouched", () => {
  const args = parse(["lab", "run", "--", "--not-mine", "x"]);
  assert.deepEqual(args.rest, ["--not-mine", "x"]);
});

test("flagList splits on commas and drops blanks", () => {
  assert.deepEqual(flagList(parse(["a", "--lang", "go, rust ,"]), "lang"), [
    "go",
    "rust",
  ]);
});

test("flagNumber rejects non-numeric input rather than yielding NaN", () => {
  assert.equal(flagNumber(parse(["a", "--page", "3"]), "page"), 3);
  assert.equal(flagNumber(parse(["a", "--page", "x"]), "page"), undefined);
});

test("a value that looks like a flag is not consumed as one", () => {
  const args = parse(["a", "--out", "--json"]);
  assert.equal(args.flags["out"], true);
  assert.equal(args.flags["json"], true);
});
