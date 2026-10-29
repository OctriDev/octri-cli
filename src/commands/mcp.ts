/**
 * `octri mcp …`: the project's own MCP server as its owner manages it: which
 * tools an agent may call and how, what agents actually called, and the npm
 * package that ships the server under the customer's name.
 *
 * `octri mcp tools` (the public catalogue) lives in docs.ts with the other
 * reader-facing surfaces; `octri mcp serve` is this CLI's own MCP server.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import * as api from "../api.js";
import { flagBool, flagNumber, flagString } from "../args.js";
import { bold, dim, green, red, yellow } from "../ui/ansi.js";
import {
  bytes,
  emit,
  heading,
  keyValues,
  line,
  note,
  relativeTime,
  success,
  warn,
} from "../ui/output.js";
import { withSpinner } from "../ui/spinner.js";
import { table } from "../ui/table.js";

import type { Context } from "../context.js";

const POLICIES: readonly api.McpToolPolicy[] = ["auto", "confirm", "off"];

function policyLabel(policy: api.McpToolPolicy): string {
  if (policy === "auto") return green(policy);
  if (policy === "off") return red(policy);
  return yellow(policy);
}

/** `octri mcp permissions`: every operation tool with what an agent may do. */
export async function mcpPermissions(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const result = await withSpinner("Loading tool permissions", () =>
    api.getMcpOwnerTools(ctx.client, projectId),
  );

  emit({ projectId, ...result }, () => {
    heading(
      `MCP tool permissions ${dim(`(${result.tools.length}, revision ${result.policiesRevision})`)}`,
    );
    table(
      result.tools,
      [
        { header: "tool", value: (t) => bold(t.name), flex: 2, minWidth: 18 },
        {
          header: "endpoint",
          value: (t) => dim(`${t.http.method.toUpperCase()} ${t.http.path}`),
          flex: 1,
          minWidth: 16,
        },
        {
          header: "policy",
          value: (t) => policyLabel(t.policy ?? api.defaultMcpPolicy(t.http.method)),
          flex: 5,
        },
        {
          header: "destructive",
          value: (t) => (t.destructive === true ? yellow("yes") : dim("no")),
          flex: 6,
        },
      ],
      { emptyMessage: "No operation tools. Push a spec first." },
    );
    note("octri mcp permissions set <tool> <auto|confirm|off>");
  });
}

/**
 * `octri mcp permissions set <tool> <auto|confirm|off> [--destructive|--no-destructive]`
 *
 * Takes the tool name or its endpoint slug. Publishes straight away, like the
 * MCP page's Publish: switching a dangerous tool off must not wait for an SDK
 * release. The write lands only on the revision just read, so a teammate's
 * publish in between is reported rather than overwritten.
 */
export async function mcpPermissionSet(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const [toolArg, policyArg] = ctx.args.positionals;
  const destructive = ctx.args.flags["destructive"];
  if (
    toolArg === undefined ||
    (policyArg === undefined && typeof destructive !== "boolean")
  ) {
    throw new Error(
      "Usage: octri mcp permissions set <tool> <auto|confirm|off> [--destructive|--no-destructive]",
    );
  }
  if (policyArg !== undefined && !POLICIES.includes(policyArg as api.McpToolPolicy)) {
    throw new Error(`Policy must be one of ${POLICIES.join(", ")}.`);
  }

  const change: api.McpPolicyEntry = {
    ...(policyArg === undefined ? {} : { policy: policyArg as api.McpToolPolicy }),
    ...(typeof destructive === "boolean" ? { destructive } : {}),
  };
  const { tool, entry, policiesRevision } = await withSpinner(
    `Publishing permissions for ${bold(toolArg)}`,
    () => api.setMcpToolPolicy(ctx.client, projectId, toolArg, change),
  );
  emit({ projectId, tool: tool.name, slug: tool.slug, ...entry, policiesRevision }, () =>
    success(
      `${bold(tool.name)} is ${policyLabel(entry.policy ?? api.defaultMcpPolicy(tool.http.method))} ${dim(`(revision ${policiesRevision})`)}`,
    ),
  );
}

/** `octri mcp usage [--days 30]`: calls per tool, by outcome. */
export async function mcpUsage(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const days = flagNumber(ctx.args, "days") ?? 30;
  const usage = await withSpinner("Loading MCP usage", () =>
    api.getMcpUsage(ctx.client, projectId, days),
  );

  emit({ projectId, ...usage }, () => {
    heading(`MCP usage ${dim(`(${usage.totalCalls} calls, last ${usage.days} days)`)}`);
    table(
      usage.tools,
      [
        { header: "tool", value: (t) => bold(t.tool), flex: 2, minWidth: 18 },
        { header: "calls", value: (t) => String(t.calls), align: "right", flex: 6 },
        { header: "ok", value: (t) => green(String(t.ok)), align: "right", flex: 7 },
        {
          header: "errors",
          value: (t) => (t.errors > 0 ? red(String(t.errors)) : dim("0")),
          align: "right",
          flex: 7,
        },
        {
          header: "declined",
          value: (t) => String(t.declined + t.blocked),
          align: "right",
          flex: 7,
        },
        { header: "last", value: (t) => relativeTime(t.lastCalledAt), flex: 5 },
        { header: "clients", value: (t) => dim(t.clients.join(", ")), flex: 1 },
      ],
      { emptyMessage: "No agent has called this project's tools yet." },
    );
  });
}

function outcomeLabel(outcome: api.McpRecentCall["outcome"]): string {
  if (outcome === "ok") return green(outcome);
  if (outcome === "error") return red(outcome);
  return yellow(outcome);
}

/** `octri mcp calls`: the latest tool calls, newest first. */
export async function mcpCalls(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const calls = await withSpinner("Loading recent calls", () =>
    api.listMcpCalls(ctx.client, projectId),
  );

  emit({ projectId, calls }, () => {
    heading(`Recent MCP calls ${dim(`(${calls.length})`)}`);
    table(
      calls,
      [
        { header: "when", value: (c) => relativeTime(c.calledAt), flex: 5 },
        { header: "tool", value: (c) => bold(c.tool), flex: 2, minWidth: 18 },
        { header: "outcome", value: (c) => outcomeLabel(c.outcome), flex: 5 },
        {
          header: "ms",
          value: (c) => (c.durationMs === undefined ? "" : String(c.durationMs)),
          align: "right",
          flex: 7,
        },
        { header: "client", value: (c) => dim(c.client ?? ""), flex: 1 },
      ],
      { emptyMessage: "No calls yet." },
    );
  });
}

/** `octri mcp package`: the npm package, its next version, and past publishes. */
export async function mcpPackage(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const pkg = await withSpinner("Loading MCP package", () =>
    api.getMcpPackage(ctx.client, projectId),
  );

  emit({ projectId, ...pkg }, () => {
    heading("MCP package");
    keyValues([
      ["package", bold(pkg.packageName)],
      ["command", pkg.binName],
      ["variables", `${pkg.envPrefix}_*`],
      ["next version", pkg.nextVersion],
      ["tools", String(pkg.toolCount)],
      ["npm account", pkg.npmLinked ? green("linked") : yellow("not linked")],
    ]);
    if (pkg.releases.length > 0) {
      heading("Releases");
      table(
        pkg.releases,
        [
          { header: "version", value: (r) => bold(r.version), flex: 4 },
          {
            header: "status",
            value: (r) =>
              r.status === "published"
                ? green(r.status)
                : r.status === "failed"
                  ? red(r.status)
                  : yellow(r.status),
            flex: 4,
          },
          { header: "tools", value: (r) => String(r.toolCount), align: "right", flex: 6 },
          { header: "requested", value: (r) => relativeTime(r.requestedAt), flex: 5 },
          { header: "detail", value: (r) => dim(r.error ?? r.url ?? ""), flex: 1 },
        ],
      );
    }
    if (!pkg.npmLinked) {
      note("Link an npm account under Publishing in SDK Studio, or run `octri mcp package download`.");
    }
  });
}

/** `octri mcp package download [--out dir]`: the files a publish would send, zipped. */
export async function mcpPackageDownload(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const out = resolvePath(flagString(ctx.args, "out") ?? ".");
  const { bytes: zip, filename } = await withSpinner("Downloading MCP package", () =>
    api.downloadMcpPackage(ctx.client, projectId),
  );

  mkdirSync(out, { recursive: true });
  // The API names the file after the package command, which is already a
  // plain slug; anything else falls back to a fixed name.
  const name =
    filename !== undefined && /^[A-Za-z0-9._-]+\.zip$/.test(filename)
      ? filename
      : "mcp-package.zip";
  const path = join(out, name);
  writeFileSync(path, zip);
  emit({ projectId, path, bytes: zip.length }, () =>
    success(`Saved ${bold(path)} ${dim(`(${bytes(zip.length)})`)}`),
  );
}

/**
 * `octri mcp package publish [--version 1.2.0] --yes`
 *
 * Publishes to the linked npm account: a public release under the customer's
 * name, so it asks for --yes like every other irreversible command.
 */
export async function mcpPackagePublish(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const version = flagString(ctx.args, "version");
  if (!flagBool(ctx.args, "yes")) {
    warn(
      "This publishes the MCP server to npm under your package name. Re-run with --yes to confirm.",
    );
    return;
  }
  const release = await withSpinner("Publishing MCP package", () =>
    api.publishMcpPackage(ctx.client, projectId, version),
  );
  emit(release, () => {
    success(
      `Publishing ${bold(`${release.packageName}@${release.version}`)} ${dim(`(${release.toolCount} tools)`)}`,
    );
    note("octri mcp package: follow the release status");
  });
}

function gradeLabel(grade: string | null): string {
  if (grade === null) return dim("-");
  if (grade === "A" || grade === "B") return green(grade);
  if (grade === "C") return yellow(grade);
  return red(grade);
}

function scoreText(score: number | null): string {
  return score === null ? "-" : score.toFixed(1);
}

/**
 * `octri mcp score [--tool <name>] [--all] [--fail-under <0-10>]`
 *
 * The tool quality score of what agents are served, out of 10: worst tools
 * first, server findings, and the rules that cost the most. `--tool` prints one
 * tool's findings and suggested rewrites. Read only: fixes are accepted on the
 * MCP page and shipped by Publish. `--fail-under` exits 1 below the threshold,
 * for CI.
 */
export async function mcpScore(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const failUnder = flagNumber(ctx.args, "fail-under");
  if (ctx.args.flags["fail-under"] !== undefined && (failUnder === undefined || failUnder < 0 || failUnder > 10)) {
    throw new Error("--fail-under takes a score from 0 to 10.");
  }
  const toolRef = flagString(ctx.args, "tool");
  const { report, history } = await withSpinner("Scoring MCP tools", () => api.getMcpQuality(ctx.client, projectId));
  const below = failUnder !== undefined && report.score !== null && report.score < failUnder;

  if (toolRef !== undefined) {
    const tool = report.tools.find((t) => t.name === toolRef || t.slug === toolRef);
    if (tool === undefined) throw new Error(`No served tool is called "${toolRef}".`);
    emit({ projectId, tool }, () => {
      heading(`${tool.name} ${dim(`${scoreText(tool.score)} / 10`)} ${gradeLabel(tool.grade)}`);
      keyValues([["tokens", `about ${tool.tokens.toLocaleString("en-US")} per turn`]]);
      for (const finding of tool.findings.filter((f) => f.severity !== "info")) {
        const label = finding.severity === "high" ? red("high") : finding.severity === "medium" ? yellow("medium") : dim(finding.severity);
        line();
        line(`  ${label}  ${finding.message}`);
        for (const suggestion of finding.suggestions ?? []) {
          const target = suggestion.target.kind === "field" ? `input ${suggestion.target.inputName ?? ""}` : suggestion.target.kind;
          line(`    ${dim(`${target}${suggestion.needsEdit ? ", read first" : ""}:`)} ${suggestion.after}`);
        }
      }
      note("Accept fixes on the MCP page; Publish ships them to agents.");
    });
  } else {
    const shown = flagBool(ctx.args, "all") ? report.tools : report.tools.slice(0, 15);
    emit({ projectId, ...report, history }, () => {
      heading(`MCP tool quality ${bold(`${scoreText(report.score)} / 10`)} ${gradeLabel(report.grade)}`);
      const previous = history[1]?.score;
      keyValues([
        ["definitions", scoreText(report.definitions)],
        ["coherence", scoreText(report.coherence)],
        ["listing", report.mode === "search" ? "search mode" : "every tool"],
        ["tokens listed", `about ${report.tokens.listed.toLocaleString("en-US")}`],
        ...(previous !== undefined && previous !== null && history[0]?.score !== null && history[0] !== undefined
          ? ([["last publish", `${scoreText(history[0].score)} (was ${scoreText(previous)})`]] as [string, string][])
          : []),
      ]);
      table(
        shown,
        [
          { header: "tool", value: (t) => bold(t.name), flex: 2, minWidth: 18 },
          { header: "grade", value: (t) => gradeLabel(t.grade), flex: 6 },
          { header: "score", value: (t) => scoreText(t.score), align: "right", flex: 6 },
          {
            header: "top finding",
            value: (t) => dim(t.findings.find((f) => f.severity === "high" || f.severity === "medium")?.message ?? ""),
            flex: 1,
            minWidth: 20,
          },
        ],
        { emptyMessage: "No tools are served. Push a spec, or switch tools on from the MCP page." },
      );
      if (shown.length < report.tools.length) note(`${report.tools.length - shown.length} more; --all lists every tool.`);
      for (const finding of report.findings) warn(finding.message);
      note("octri mcp score --tool <name> shows one tool's suggested rewrites.");
    });
  }

  if (below) {
    warn(`Score ${scoreText(report.score)} is under --fail-under ${String(failUnder)}.`);
    process.exitCode = 1;
  }
}
