/**
 * Output routing.
 *
 * Every human-facing line goes through here so that `--json` and `--quiet` can
 * be honoured globally: in JSON mode the decorative stream is suppressed and
 * exactly one machine-readable document is written to stdout, which is what the
 * MCP layer and CI pipelines consume.
 */

import {
  accent,
  bold,
  cyan,
  dim,
  gray,
  green,
  hasUnicode,
  red,
  yellow,
} from "./ansi.js";

// ─── Mode ─────────────────────────────────────────────────────────────────────

interface OutputMode {
  json: boolean;
  quiet: boolean;
  /** Suppresses animation frames (spinners fall back to one static line). */
  plain: boolean;
}

const mode: OutputMode = { json: false, quiet: false, plain: false };

export function configureOutput(next: Partial<OutputMode>): void {
  Object.assign(mode, next);
}

export function isJson(): boolean {
  return mode.json;
}

export function isQuiet(): boolean {
  return mode.quiet || mode.json;
}

/** True when animation would be wasted (piped output, CI, --json, --plain). */
export function isStatic(): boolean {
  return (
    mode.plain ||
    mode.json ||
    mode.quiet ||
    process.stdout.isTTY !== true ||
    process.env["CI"] !== undefined
  );
}

// ─── Symbols ──────────────────────────────────────────────────────────────────

export const symbols = hasUnicode
  ? {
      ok: "✔",
      fail: "✖",
      warn: "▲",
      info: "•",
      arrow: "→",
      bullet: "·",
      pointer: "❯",
      queued: "◌",
      running: "◍",
      dot: "●",
      ellipsis: "…",
    }
  : {
      ok: "v",
      fail: "x",
      warn: "!",
      info: "*",
      arrow: "->",
      bullet: "-",
      pointer: ">",
      queued: "o",
      running: "o",
      dot: "*",
      ellipsis: "...",
    };

// ─── Writers ──────────────────────────────────────────────────────────────────

/** Raw write to stdout, bypassing quiet (used by the live renderers). */
export function write(text: string): void {
  process.stdout.write(text);
}

export function line(text = ""): void {
  if (isQuiet()) return;
  process.stdout.write(`${text}\n`);
}

export function success(text: string): void {
  line(`${green(symbols.ok)} ${text}`);
}

export function fail(text: string): void {
  // Failures go to stderr so they survive `--json | jq` and `> out.json`.
  process.stderr.write(`${red(symbols.fail)} ${text}\n`);
}

export function warn(text: string): void {
  if (mode.json) return;
  process.stderr.write(`${yellow(symbols.warn)} ${text}\n`);
}

export function info(text: string): void {
  line(`${accent(symbols.info)} ${text}`);
}

export function note(text: string): void {
  line(dim(`  ${text}`));
}

export function step(text: string): void {
  line(`${dim(symbols.arrow)} ${text}`);
}

export function heading(text: string): void {
  line();
  line(bold(accent(text)));
}

/** Emits the single JSON document for `--json`, or nothing outside JSON mode. */
export function json(value: unknown): void {
  if (!mode.json) return;
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * The common shape of a command result: a machine document plus a human
 * renderer. Commands build both and let the mode decide which one runs.
 */
export function emit(value: unknown, render: () => void): void {
  if (mode.json) {
    json(value);
    return;
  }
  render();
}

// ─── Small composites ─────────────────────────────────────────────────────────

/** Aligned `key  value` block — the workhorse for `show` style commands. */
export function keyValues(
  entries: readonly (readonly [string, string])[],
  indent = "  ",
): void {
  if (entries.length === 0) return;
  const width = Math.max(...entries.map(([k]) => k.length));
  for (const [key, value] of entries) {
    line(`${indent}${gray(key.padEnd(width))}  ${value}`);
  }
}

/** Colours a lifecycle status token consistently everywhere it appears. */
export function statusLabel(status: string): string {
  switch (status) {
    case "ready":
    case "verified":
    case "completed":
    case "published":
    case "active":
      return green(status);
    case "failed":
    case "error":
      return red(status);
    case "partial":
    case "queued":
    case "pending":
      return yellow(status);
    case "generating":
    case "verifying":
    case "packaging":
    case "installing":
    case "processing":
      return cyan(status);
    default:
      return dim(status);
  }
}

/** Human byte size — artifacts are reported in bytes by the API. */
export function bytes(value: number | undefined): string {
  if (value === undefined) return dim("—");
  const units = ["B", "KB", "MB", "GB"];
  let n = value;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  return `${n < 10 && u > 0 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}

/** Compact relative time, e.g. `4m ago`. Falls back to the raw string. */
export function relativeTime(iso: string | undefined): string {
  if (iso === undefined) return dim("—");
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** `1m 12s` from a millisecond span — used by the build timers. */
export function duration(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}
