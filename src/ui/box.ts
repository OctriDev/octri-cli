/**
 * Framed output — the banner, panels, rules and file trees.
 */

import {
  bold,
  dim,
  gradient,
  hasUnicode,
  pad,
  terminalWidth,
  truncate,
  visibleWidth,
  accent,
} from "./ansi.js";
import { isQuiet, isStatic, line, write } from "./output.js";

const B = hasUnicode
  ? { h: "─", v: "│", tl: "╭", tr: "╮", bl: "╰", br: "╯" }
  : { h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+" };

/** Horizontal rule, optionally with an inline label. */
export function rule(label?: string): void {
  const width = terminalWidth();
  if (label === undefined) {
    line(dim(B.h.repeat(width)));
    return;
  }
  const text = ` ${label} `;
  const rest = Math.max(0, width - visibleWidth(text) - 2);
  line(`${dim(B.h.repeat(2))}${accent(text)}${dim(B.h.repeat(rest))}`);
}

export interface PanelOptions {
  title?: string;
  tone?: "default" | "success" | "danger";
  width?: number;
}

/** Boxed block of lines. Content is truncated, never wrapped mid-escape. */
export function panel(
  lines: readonly string[],
  { title, width }: PanelOptions = {},
): void {
  if (isQuiet()) return;
  const inner =
    (width ?? Math.min(terminalWidth(), 88)) - 4;
  const top =
    title === undefined
      ? `${B.tl}${B.h.repeat(inner + 2)}${B.tr}`
      : `${B.tl}${B.h} ${title} ${B.h.repeat(Math.max(0, inner - visibleWidth(title) - 1))}${B.tr}`;

  line(dim(top));
  for (const content of lines) {
    line(`${dim(B.v)} ${pad(truncate(content, inner), inner)} ${dim(B.v)}`);
  }
  line(dim(`${B.bl}${B.h.repeat(inner + 2)}${B.br}`));
}

// ─── Banner ───────────────────────────────────────────────────────────────────

const WORDMARK = [
  "  ___   ___ _____ ___ ___ ",
  " / _ \\ / __|_   _| _ \\_ _|",
  "| (_) | (__  | | |   /| | ",
  " \\___/ \\___| |_| |_|_\\___|",
];

/**
 * Brand banner. Outside a TTY it collapses to one line — nobody wants ASCII art
 * in a CI log, and `--json` suppresses it entirely.
 */
export function banner(subtitle?: string): void {
  if (isQuiet()) return;
  if (isStatic()) {
    line(`${bold("octri")}${subtitle === undefined ? "" : dim(` — ${subtitle}`)}`);
    return;
  }
  line();
  for (const row of WORDMARK) line(`  ${gradient(row)}`);
  if (subtitle !== undefined) line(`  ${dim(subtitle)}`);
  line();
}

/**
 * Reveals text one character at a time. Used sparingly — the banner subtitle
 * and the "build complete" line — and skipped entirely when not interactive.
 */
export async function typewriter(text: string, msPerChar = 12): Promise<void> {
  if (isStatic()) {
    line(text);
    return;
  }
  for (const char of text) {
    write(char);
    await new Promise((resolve) => setTimeout(resolve, msPerChar));
  }
  write("\n");
}

// ─── File tree ────────────────────────────────────────────────────────────────

export interface TreeNode {
  name: string;
  /** Right-aligned annotation — file size, language, status. */
  detail?: string;
  children?: TreeNode[];
}

/** Renders a nested tree with box-drawing connectors. */
export function tree(nodes: readonly TreeNode[], prefix = ""): void {
  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1;
    const connector = hasUnicode
      ? last
        ? "└─ "
        : "├─ "
      : last
        ? "`- "
        : "|- ";
    const detail = node.detail === undefined ? "" : `  ${dim(node.detail)}`;
    line(`${dim(prefix + connector)}${node.name}${detail}`);
    if (node.children !== undefined && node.children.length > 0) {
      tree(node.children, prefix + (last ? "   " : hasUnicode ? "│  " : "|  "));
    }
  });
}

/** Builds a `TreeNode[]` from flat POSIX-ish paths (artifact listings). */
export function treeFromPaths(
  entries: readonly { path: string; detail?: string }[],
): TreeNode[] {
  const root: TreeNode[] = [];

  for (const entry of entries) {
    const parts = entry.path.split("/").filter((p) => p.length > 0);
    let level = root;
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1;
      let node = level.find((n) => n.name === part);
      if (node === undefined) {
        node = leaf
          ? { name: part, ...(entry.detail === undefined ? {} : { detail: entry.detail }) }
          : { name: part, children: [] };
        level.push(node);
      }
      if (!leaf) {
        node.children ??= [];
        level = node.children;
      }
    });
  }

  return root;
}
