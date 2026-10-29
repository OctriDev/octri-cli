/**
 * `octri mcp …`: the project's own MCP server as its owner manages it: which
 * tools an agent may call and how, what agents actually called, and the npm
 * package that ships the server under the customer's name.
 *
 * `octri mcp tools` (the public catalogue) lives in docs.ts with the other
 * reader-facing surfaces; `octri mcp serve` is this CLI's own MCP server.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import * as api from "../api.js";
import { flagBool, flagList, flagNumber, flagString } from "../args.js";
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

const WORKFLOW_STATUS: Record<api.GuideWorkflowPublished["status"], string> = {
  current: green("up to date"),
  stale: yellow("guide changed"),
  orphaned: red("guide gone"),
};

/**
 * `octri mcp workflows [--guide <slug>] [--stale]`
 *
 * Which guides have a workflow tool and prompt, and whether each still matches
 * the published guide. Read only: workflows are made and updated on the MCP
 * page and shipped by Publish. `--stale` exits 1 when any is out of date,
 * for CI after a docs change.
 */
export async function mcpWorkflows(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const only = flagString(ctx.args, "guide");
  const body = await withSpinner("Reading guide workflows", () => api.getMcpGuideWorkflows(ctx.client, projectId));
  const guides = only !== undefined ? body.guides.filter((g) => g.slug === only || g.id === only) : body.guides;
  if (only !== undefined && guides.length === 0) throw new Error(`No guide is called "${only}".`);
  const outOfDate = [...guides.filter((g) => g.workflow !== undefined && g.workflow.status !== "current"), ...(only === undefined ? body.orphans : [])];

  emit({ projectId, mode: body.mode, guides, orphans: body.orphans }, () => {
    heading(`Guide workflows ${dim(body.mode === "all" ? "every published guide" : "guides you pick")}`);
    table(
      guides,
      [
        { header: "guide", value: (g) => bold(g.title), flex: 2, minWidth: 18 },
        { header: "tool", value: (g) => g.workflow?.tool ?? dim(g.published ? (g.calls > 0 ? "none yet" : "no API calls") : "unpublished"), flex: 2, minWidth: 14 },
        { header: "state", value: (g) => (g.workflow !== undefined ? WORKFLOW_STATUS[g.workflow.status] : ""), flex: 3 },
        { header: "served", value: (g) => (g.workflow === undefined ? "" : g.workflow.served ? "yes" : dim("off")), flex: 6 },
      ],
      { emptyMessage: "This project has no guides yet." },
    );
    for (const orphan of only === undefined ? body.orphans : []) warn(`${orphan.tool ?? orphan.prompt ?? orphan.slug} was made from a guide that no longer exists (${orphan.slug}).`);
    note("Make and update workflows on the MCP page; Publish ships them to agents.");
  });

  if (flagBool(ctx.args, "stale") && outOfDate.length > 0) {
    warn(`${outOfDate.length} guide workflow${outOfDate.length === 1 ? " is" : "s are"} out of date.`);
    process.exitCode = 1;
  }
}

const VERDICT_TEXT: Record<api.McpTestVerdict, (text: string) => string> = { pass: green, flaky: yellow, fail: red };

/** How long `octri mcp test` follows a run before giving up on it (the API ends a run at 15 minutes). */
const MCP_TEST_WAIT_MS = 20 * 60_000;
const MCP_TEST_POLL_MS = 2_000;

function readJsonFile(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(resolvePath(path), "utf8")) as unknown;
  } catch (err) {
    throw new Error(`Could not read ${what} from ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * `octri mcp test [--models a,b] [--repeat N] [--task <id>,...] [--tasks <file>] [--draft <file>] [--fail-under <0-1>] [--no-wait]`
 *
 * Runs real models against the MCP tools on the project's sample tasks, as a
 * dry run (every call answered from the spec's examples; your API is never
 * called), and prints each model's pass rate. Tests what is published, or the
 * draft in `--draft` (the MCP page's publish body). `--tasks` REPLACES the
 * project's saved tasks with the file's before running. Exits 1 when a model
 * fails a task, or with `--fail-under` when a model's pass rate is under it,
 * for CI. Spends AI credits.
 */
export async function mcpTest(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const failUnder = flagNumber(ctx.args, "fail-under");
  if (ctx.args.flags["fail-under"] !== undefined && (failUnder === undefined || failUnder < 0 || failUnder > 1)) {
    throw new Error("--fail-under takes a pass rate from 0 to 1, such as 0.9.");
  }
  const repeat = flagNumber(ctx.args, "repeat");
  if (ctx.args.flags.repeat !== undefined && (repeat === undefined || !Number.isInteger(repeat) || repeat < 1 || repeat > 5)) {
    throw new Error("--repeat takes a whole number from 1 to 5.");
  }
  const models = flagList(ctx.args, "models");
  const taskIds = flagList(ctx.args, "task");

  const tasksFile = flagString(ctx.args, "tasks");
  if (tasksFile !== undefined) {
    const tasks = readJsonFile(tasksFile, "tasks");
    if (!Array.isArray(tasks)) throw new Error("--tasks takes a JSON file holding a list of tasks.");
    const saved = await withSpinner("Saving sample tasks", () => api.saveMcpTestTasks(ctx.client, projectId, tasks));
    success(`Saved ${saved.tasks.length} sample ${saved.tasks.length === 1 ? "task" : "tasks"}.`);
  }

  const draftFile = flagString(ctx.args, "draft");
  let draft: api.McpDraftBody;
  if (draftFile !== undefined) {
    draft = readJsonFile(draftFile, "the draft") as api.McpDraftBody;
  } else {
    const listing = await withSpinner("Reading the published tools", () => api.getMcpPublishedListing(ctx.client, projectId));
    // Only the publish body's own keys: the listing carries the tools too.
    draft = { policies: listing.policies };
    for (const key of ["overrides", "groups", "customTools", "prompts", "resources", "toolMode", "outageWarnings", "changeNotices", "practiceMode", "errorGuides"] as const) {
      if (listing[key] !== undefined) Object.assign(draft, { [key]: listing[key] });
    }
  }

  let run = await withSpinner("Queueing the test run", () =>
    api.startMcpTestRun(ctx.client, projectId, {
      draft,
      ...(models.length > 0 ? { models } : {}),
      ...(repeat !== undefined ? { repeat } : {}),
      ...(taskIds.length > 0 ? { taskIds } : {}),
    }));

  if (ctx.args.flags.wait === false || flagBool(ctx.args, "no-wait")) {
    emit({ projectId, run }, () => {
      success(`Queued test run ${run.id}: ${run.total} attempts on ${run.models.join(", ")}.`);
      note("Follow it on the MCP page.");
    });
    return;
  }

  const startedAt = Date.now();
  run = await withSpinner(`Running ${run.total} attempts`, async () => {
    let current = run;
    while (current.state === "queued" || current.state === "running") {
      if (Date.now() - startedAt > MCP_TEST_WAIT_MS) throw new Error(`Test run ${current.id} did not finish in time. See it on the MCP page.`);
      await new Promise((r) => setTimeout(r, MCP_TEST_POLL_MS));
      current = await api.getMcpTestRun(ctx.client, projectId, current.id);
    }
    return current;
  });

  const summary = run.summary;
  emit({ projectId, run }, () => {
    const verdict = summary?.verdict ?? "fail";
    heading(`MCP agent test ${VERDICT_TEXT[verdict](verdict)}`);
    keyValues([
      ["run", run.id],
      ["state", run.state],
      ["tasks", String(run.tasks.length)],
      ["model spend", summary !== undefined ? `$${summary.costUsd.toFixed(2)}` : "-"],
    ]);
    table(
      summary?.models ?? [],
      [
        { header: "model", value: (m) => bold(m.model), flex: 2, minWidth: 18 },
        { header: "verdict", value: (m) => VERDICT_TEXT[m.verdict](m.verdict), flex: 6 },
        { header: "pass rate", value: (m) => `${Math.round(m.passRate * 100)}%`, align: "right", flex: 6 },
        { header: "tasks", value: (m) => `${m.tasksPassed}/${m.tasksPassed + m.tasksFlaky + m.tasksFailed}`, align: "right", flex: 6 },
        { header: "tokens/task", value: (m) => m.tokensPerTask.toLocaleString("en-US"), align: "right", flex: 6 },
      ],
      { emptyMessage: run.error ?? "No attempt finished." },
    );
    for (const task of (summary?.tasks ?? []).filter((t) => t.verdict === "fail")) {
      const why = run.attempts.find((a) => a.taskId === task.taskId && a.model === task.model && a.outcome !== "pass");
      warn(`${task.taskId} fails on ${task.model}${why !== undefined ? `: ${why.outcome}${why.error !== undefined ? ` (${why.error})` : ""}` : ""}`);
    }
    note("Transcripts are on the MCP page.");
  });

  const under = failUnder !== undefined
    ? (summary?.models ?? []).some((m) => m.passRate < failUnder) || summary === undefined
    : summary?.verdict !== "pass" && summary?.verdict !== "flaky";
  if (run.state !== "done" || under) process.exitCode = 1;
}
