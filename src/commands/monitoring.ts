/**
 * `octri monitoring …` — the monitoring product.
 *
 * Two transports live behind this one group, deliberately:
 *
 *  - Reads and triage go through the dashboard's monitoring proxy, so they use
 *    the signed-in session and inherit the project's scope and RBAC.
 *  - `sourcemaps upload` / `sources upload` POST at the monitoring service with
 *    the project's ingest token, because a CI job has one secret and no login.
 *    When you are signed in the connection is resolved for you; when the flags
 *    (or their env vars) are present the API is never contacted at all.
 */

import { flagBool, flagNumber, flagString } from "../args.js";
import * as api from "../api.js";
import type { Context } from "../context.js";
import {
  gitRelease,
  uploadSourceFiles,
  uploadSourceMaps,
} from "../monitoring/upload.js";
import { accent, bold, dim, red, yellow } from "../ui/ansi.js";
import { rule } from "../ui/box.js";
import {
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

/** Windowed reads all accept the same shorthand; the proxy validates it. */
const DEFAULT_RANGE = "24h";

function range(ctx: Context): string {
  return flagString(ctx.args, "range") ?? DEFAULT_RANGE;
}

function limit(ctx: Context, fallback: number): number {
  return flagNumber(ctx.args, "limit") ?? fallback;
}

/** Colours a log/issue level the way the dashboard does. */
function level(value: string | undefined): string {
  switch (value) {
    case "fatal":
    case "error":
      return red(value);
    case "warning":
      return yellow(value);
    case undefined:
      return dim("—");
    default:
      return dim(value);
  }
}

function percent(value: number | undefined): string {
  if (value === undefined) return dim("—");
  return `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
}

function ms(value: number | null | undefined): string {
  if (value === null || value === undefined) return dim("—");
  return value >= 1_000 ? `${(value / 1_000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

// ─── Connection ───────────────────────────────────────────────────────────────

export async function monitoringStatus(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const connection = await withSpinner("Reading monitoring connection", () =>
    api.monitoringConnection(ctx.client, projectId),
  );

  emit(connection, () => {
    heading("Monitoring");
    keyValues([
      ["project", projectId],
      [
        "status",
        connection.enabled
          ? accent("enabled")
          : connection.configured
            ? yellow("off for this project")
            : red("not configured on this instance"),
      ],
      ["environment", connection.environment ?? "—"],
      ["ingest URL", connection.ingestUrl ?? "—"],
      ["status page", connection.statusPageEnabled === true ? "published" : "off"],
      ["docs banner", connection.docsBannerEnabled === true ? "on" : "off"],
      ...(connection.statusDomain === undefined
        ? []
        : ([["status domain", connection.statusDomain]] as const)),
    ]);
    if (!connection.enabled && connection.configured) {
      note("octri monitoring enable");
    }
  });
}

export async function monitoringEnable(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const connection = await withSpinner("Enabling monitoring", () =>
    api.setMonitoringEnabled(ctx.client, projectId, true),
  );
  emit(connection, () => {
    success(`Monitoring enabled ${dim(`(environment ${connection.environment ?? "—"})`)}`);
    note("Rebuild your SDKs so they carry the ingest config: octri sdk build");
  });
}

export async function monitoringDisable(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const connection = await withSpinner("Disabling monitoring", () =>
    api.setMonitoringEnabled(ctx.client, projectId, false),
  );
  emit(connection, () => success("Monitoring disabled."));
}

/**
 * `octri monitoring config` — the ingest credentials, for pasting into CI. The
 * token is printed only on request, so a screen-shared terminal does not leak it.
 */
export async function monitoringConfig(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const config = await withSpinner("Reading ingest configuration", () =>
    api.monitoringSdkConfig(ctx.client, projectId),
  );
  const reveal = flagBool(ctx.args, "reveal-token");

  emit(reveal ? config : { ...config, token: undefined }, () => {
    heading("Ingest configuration");
    keyValues([
      ["MONITORING_URL", config.baseUrl],
      ["MONITORING_ENVIRONMENT", config.environment],
      [
        "MONITORING_TOKEN",
        config.token === undefined
          ? dim("—")
          : reveal
            ? config.token
            : dim("hidden — pass --reveal-token"),
      ],
    ]);
    note("These are the three values `octri monitoring sourcemaps upload` needs in CI.");
  });
}

// ─── Overview ─────────────────────────────────────────────────────────────────

export async function monitoringSummary(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const window = range(ctx);
  const summary = await withSpinner(`Reading the last ${window}`, () =>
    api.monitoringSummary(ctx.client, projectId, window),
  );

  emit(summary, () => {
    heading(`Last ${window}`);
    keyValues([
      ["events", String(summary.total)],
      ["errors", String(summary.errors)],
      ["error rate", percent(summary.errorRate)],
      ["distinct issues", String(summary.distinctIssues)],
    ]);
    const levels = Object.entries(summary.byLevel ?? {});
    if (levels.length > 0) {
      line();
      line(
        `  ${levels.map(([name, count]) => `${level(name)} ${bold(String(count))}`).join(dim("  ·  "))}`,
      );
    }
  });
}

// ─── Issues ───────────────────────────────────────────────────────────────────

export async function monitoringIssues(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const query = {
    range: range(ctx),
    limit: limit(ctx, 25),
    ...pickFlag(ctx, "status"),
    ...pickFlag(ctx, "level"),
    ...pickFlag(ctx, "sort"),
    ...pickFlag(ctx, "q", "query"),
  };
  const { items, count } = await withSpinner("Loading issues", () =>
    api.monitoringIssues(ctx.client, projectId, query),
  );

  emit({ count, items }, () => {
    heading(`Issues ${dim(`(${items.length} of ${count})`)}`);
    table(
      items,
      [
        { header: "id", value: (i) => dim(i._id.slice(-8)), flex: 8, minWidth: 8 },
        { header: "lvl", value: (i) => level(i.level), flex: 9, minWidth: 5 },
        {
          header: "title",
          value: (i) => bold(i.title ?? i.lastMessage ?? i.fingerprint),
          flex: 1,
          minWidth: 24,
        },
        { header: "events", value: (i) => String(i.count), flex: 8 },
        { header: "users", value: (i) => String(i.usersAffected), flex: 8 },
        { header: "status", value: (i) => statusColour(i.status), flex: 7 },
        { header: "last seen", value: (i) => relativeTime(i.lastSeen), flex: 6 },
      ],
      { emptyMessage: "No issues in this window." },
    );
    if (items.length > 0) note("octri monitoring issue <id> — full stack trace");
  });
}

function statusColour(status: string): string {
  if (status === "resolved") return accent(status);
  if (status === "ignored") return dim(status);
  return yellow(status);
}

export async function monitoringIssue(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const issueId = requireArg(ctx, "octri monitoring issue <id>");
  const detail = await withSpinner("Loading issue", () =>
    api.monitoringIssue(ctx.client, projectId, issueId),
  );

  emit(detail, () => {
    const { issue, events } = detail;
    rule(issue.title ?? issue.fingerprint);
    keyValues([
      ["id", issue._id],
      ["level", level(issue.level)],
      ["status", statusColour(issue.status)],
      ["events", String(issue.count)],
      ["users affected", String(issue.usersAffected)],
      ["first seen", relativeTime(issue.firstSeen)],
      ["last seen", relativeTime(issue.lastSeen)],
      ...(issue.culprit == null ? [] : ([["culprit", issue.culprit]] as const)),
      ...(issue.path == null
        ? []
        : ([["endpoint", `${issue.method ?? ""} ${issue.path}`.trim()]] as const)),
      ...(issue.assignee?.name === undefined
        ? []
        : ([["assignee", issue.assignee.name]] as const)),
    ]);

    const frames = latestFrames(detail);
    if (frames.length > 0) {
      line();
      heading("Stack");
      for (const frame of frames.slice(0, 12)) {
        const where = `${frame.filename ?? "?"}:${frame.lineno ?? "?"}`;
        const marker = frame.resolved === true ? accent("✓") : dim("·");
        line(`  ${marker} ${bold(frame.function ?? "<anonymous>")} ${dim(where)}`);
        if (frame.contextLine !== undefined) line(dim(`      ${frame.contextLine.trim()}`));
      }
      if (frames.every((f) => f.resolved !== true)) {
        note("No frame resolved — upload symbols: octri monitoring sourcemaps upload");
      }
    }

    if (events.length > 0) {
      line();
      heading(`Recent events ${dim(`(${events.length})`)}`);
      table(
        events.slice(0, 10),
        [
          { header: "when", value: (e) => relativeTime(e.timestamp), flex: 5 },
          { header: "status", value: (e) => String(e.statusCode ?? "—"), flex: 8 },
          { header: "release", value: (e) => dim(shortRelease(e.release)), flex: 6 },
          { header: "message", value: (e) => e.message ?? "", flex: 1, minWidth: 20 },
        ],
        { emptyMessage: "" },
      );
    }
  });
}

/** The stack of the most recent event, which is what people actually want. */
function latestFrames(detail: {
  issue: api.MonitoringIssue;
  events: api.MonitoringLogEvent[];
}): api.MonitoringStackFrame[] {
  const source = detail.events[0]?.error ?? detail.issue.lastError;
  return source?.frames ?? [];
}

function shortRelease(release: string | null | undefined): string {
  if (release == null || release === "") return "—";
  return release.length > 12 ? release.slice(0, 12) : release;
}

export async function monitoringResolve(ctx: Context): Promise<void> {
  await setStatus(ctx, "resolved");
}

export async function monitoringIgnore(ctx: Context): Promise<void> {
  await setStatus(ctx, "ignored");
}

export async function monitoringReopen(ctx: Context): Promise<void> {
  await setStatus(ctx, "unresolved");
}

async function setStatus(
  ctx: Context,
  status: "unresolved" | "resolved" | "ignored",
): Promise<void> {
  const projectId = ctx.projectId();
  const issueId = requireArg(ctx, `octri monitoring ${status === "unresolved" ? "reopen" : status.replace(/d$/, "")} <id>`);
  const issue = await withSpinner(`Marking ${status}`, () =>
    api.setIssueStatus(ctx.client, projectId, issueId, status),
  );
  emit(issue, () => success(`${issue.title ?? issueId} → ${statusColour(status)}`));
}

export async function monitoringComment(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const [issueId, ...rest] = ctx.args.positionals;
  const body = rest.join(" ");
  if (issueId === undefined || body === "") {
    throw new Error("Usage: octri monitoring comment <id> <text>");
  }
  const result = await withSpinner("Posting comment", () =>
    api.commentOnIssue(ctx.client, projectId, issueId, body),
  );
  emit(result, () => success("Comment posted."));
}

// ─── Logs, traces, performance, releases ──────────────────────────────────────

export async function monitoringLogs(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const body: Record<string, unknown> = {
    range: range(ctx),
    limit: limit(ctx, 50),
    ...pickFlag(ctx, "level"),
    ...pickFlag(ctx, "q", "query"),
  };
  const { items, count } = await withSpinner("Querying logs", () =>
    api.monitoringLogs(ctx.client, projectId, body),
  );

  emit({ count, items }, () => {
    heading(`Logs ${dim(`(${items.length} of ${count})`)}`);
    table(
      items,
      [
        { header: "when", value: (e) => relativeTime(e.timestamp), flex: 6 },
        { header: "lvl", value: (e) => level(e.level), flex: 9, minWidth: 5 },
        {
          header: "endpoint",
          value: (e) => dim(`${e.method ?? ""} ${e.path ?? ""}`.trim() || "—"),
          flex: 3,
          minWidth: 14,
        },
        { header: "code", value: (e) => String(e.statusCode ?? "—"), flex: 9 },
        { header: "took", value: (e) => ms(e.latencyMs), flex: 8 },
        { header: "message", value: (e) => e.message ?? "", flex: 1, minWidth: 20 },
      ],
      { emptyMessage: "No events matched." },
    );
  });
}

export async function monitoringTraces(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const traceId = ctx.args.positionals[0];

  if (traceId !== undefined) {
    const trace = await withSpinner("Loading trace", () =>
      api.monitoringTrace(ctx.client, projectId, traceId),
    );
    emit(trace, () => {
      rule(traceId);
      line(dim(JSON.stringify(trace, null, 2)));
    });
    return;
  }

  const { items, count } = await withSpinner("Loading traces", () =>
    api.monitoringTraces(ctx.client, projectId, {
      range: range(ctx),
      limit: limit(ctx, 25),
    }),
  );

  emit({ count, items }, () => {
    heading(`Traces ${dim(`(${items.length} of ${count})`)}`);
    table(
      items,
      [
        { header: "trace", value: (t) => dim(t.traceId.slice(0, 16)), flex: 4, minWidth: 16 },
        { header: "root", value: (t) => bold(t.rootName ?? "—"), flex: 1, minWidth: 18 },
        { header: "service", value: (t) => dim(t.rootService ?? "—"), flex: 4 },
        { header: "spans", value: (t) => String(t.spanCount), flex: 9 },
        { header: "took", value: (t) => ms(t.durationMs), flex: 8 },
        { header: "", value: (t) => (t.hasError ? red("error") : accent("ok")), flex: 8 },
        { header: "when", value: (t) => relativeTime(t.start), flex: 6 },
      ],
      { emptyMessage: "No traces in this window." },
    );
  });
}

export async function monitoringPerformance(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const window = range(ctx);
  const result = await withSpinner("Loading performance", () =>
    api.monitoringPerformance(ctx.client, projectId, window),
  );

  emit(result, () => {
    heading(`Slowest transactions ${dim(`· last ${window}`)}`);
    table(
      result.transactions.slice(0, limit(ctx, 20)),
      [
        { header: "transaction", value: (t) => bold(t.transaction), flex: 1, minWidth: 24 },
        { header: "count", value: (t) => String(t.count), flex: 8 },
        { header: "p50", value: (t) => ms(t.p50), flex: 8 },
        { header: "p95", value: (t) => ms(t.p95), flex: 8 },
        { header: "errors", value: (t) => percent(t.errorRate), flex: 8 },
      ],
      { emptyMessage: "No transactions recorded." },
    );

    if (result.nPlusOne.length > 0) {
      line();
      heading("Suspected N+1 queries");
      for (const row of result.nPlusOne.slice(0, 5)) {
        line(`  ${yellow(row.service)} ${dim(`×${row.tracesAffected}`)} ${row.query}`);
      }
    }
  });
}

export async function monitoringReleases(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const releases = await withSpinner("Loading releases", () =>
    api.monitoringReleases(ctx.client, projectId, range(ctx)),
  );

  emit(releases, () => {
    heading(`Releases ${dim(`(${releases.length})`)}`);
    table(
      releases,
      [
        { header: "release", value: (r) => bold(shortRelease(r.release)), flex: 3, minWidth: 12 },
        { header: "events", value: (r) => String(r.events), flex: 8 },
        { header: "errors", value: (r) => String(r.errors), flex: 8 },
        { header: "rate", value: (r) => percent(r.errorRate), flex: 8 },
        { header: "new", value: (r) => String(r.newIssues), flex: 9 },
        { header: "regressions", value: (r) => String(r.regressions), flex: 7 },
        { header: "last seen", value: (r) => relativeTime(r.lastSeen), flex: 6 },
      ],
      { emptyMessage: "No releases reported — is `logging.release` set in your SDK?" },
    );
  });
}

// ─── Alerts + synthetic checks ────────────────────────────────────────────────

export async function monitoringAlerts(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const rules = await withSpinner("Loading alert rules", () =>
    api.monitoringAlerts(ctx.client, projectId),
  );

  emit(rules, () => {
    heading(`Alert rules ${dim(`(${rules.length})`)}`);
    table(
      rules,
      [
        { header: "id", value: (r) => dim(r._id.slice(-8)), flex: 8, minWidth: 8 },
        { header: "name", value: (r) => bold(r.name), flex: 1, minWidth: 18 },
        { header: "kind", value: (r) => dim(r.kind), flex: 6 },
        { header: "threshold", value: (r) => `${r.threshold}/${r.windowMinutes}m`, flex: 7 },
        { header: "channel", value: (r) => dim(r.channel.type), flex: 8 },
        { header: "", value: (r) => (r.enabled ? accent("on") : dim("off")), flex: 9 },
        { header: "triggered", value: (r) => relativeTime(r.lastTriggeredAt ?? undefined), flex: 6 },
      ],
      { emptyMessage: "No alert rules." },
    );
  });
}

export async function monitoringAlertCreate(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const name = ctx.args.positionals[0] ?? flagString(ctx.args, "name");
  const webhook = flagString(ctx.args, "webhook");
  const slack = flagString(ctx.args, "slack");
  const url = webhook ?? slack;

  if (name === undefined || url === undefined) {
    throw new Error(
      "Usage: octri monitoring alerts create <name> --webhook <url> | --slack <url> [--kind threshold|new_issue|regression] [--threshold N] [--window MINUTES]",
    );
  }

  const body: Record<string, unknown> = {
    name,
    kind: flagString(ctx.args, "kind") ?? "threshold",
    threshold: flagNumber(ctx.args, "threshold") ?? 10,
    windowMinutes: flagNumber(ctx.args, "window") ?? 15,
    channel: { type: slack === undefined ? "webhook" : "slack", url },
    ...pickFlag(ctx, "q", "query"),
  };

  const rule = await withSpinner("Creating alert rule", () =>
    api.createMonitoringAlert(ctx.client, projectId, body),
  );
  emit(rule, () => success(`Alert rule ${bold(rule.name)} created ${dim(rule._id)}`));
}

export async function monitoringAlertDelete(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const alertId = requireArg(ctx, "octri monitoring alerts delete <id>");
  await withSpinner("Deleting alert rule", () =>
    api.deleteMonitoringAlert(ctx.client, projectId, alertId),
  );
  emit({ deleted: alertId }, () => success(`Alert rule ${alertId} deleted.`));
}

export async function monitoringAlertEvaluate(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const result = await withSpinner("Evaluating alert rules", () =>
    api.evaluateMonitoringAlerts(ctx.client, projectId),
  );
  emit(result, () => {
    const fired = result.results.filter((r) => r.triggered === true);
    success(`Evaluated ${result.evaluated} rule(s), ${fired.length} triggered.`);
    for (const row of fired) line(`  ${yellow("triggered")} ${row.rule}`);
  });
}

export async function monitoringChecks(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const checks = await withSpinner("Loading synthetic checks", () =>
    api.monitoringChecks(ctx.client, projectId),
  );

  emit(checks, () => {
    heading(`Synthetic checks ${dim(`(${checks.length})`)}`);
    table(
      checks,
      [
        { header: "id", value: (c) => dim(c._id.slice(-8)), flex: 8, minWidth: 8 },
        { header: "name", value: (c) => bold(c.name), flex: 1, minWidth: 18 },
        { header: "target", value: (c) => dim(`${c.method} ${c.url}`), flex: 2, minWidth: 20 },
        { header: "every", value: (c) => `${c.intervalMinutes}m`, flex: 9 },
        { header: "source", value: (c) => dim(c.source), flex: 8 },
        { header: "", value: (c) => (c.enabled ? accent("on") : dim("off")), flex: 9 },
        { header: "last run", value: (c) => relativeTime(c.lastRunAt ?? undefined), flex: 6 },
      ],
      { emptyMessage: "No checks — generate them from the spec: octri monitoring checks generate" },
    );
  });
}

export async function monitoringCheckRun(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const checkId = requireArg(ctx, "octri monitoring checks run <id>");
  const result = await withSpinner("Running check", () =>
    api.runMonitoringCheck(ctx.client, projectId, checkId),
  );
  emit(result, () => {
    const ok = result["ok"] === true || result["up"] === true;
    if (ok) success(`Check passed ${dim(`(${String(result["statusCode"] ?? "")} in ${String(result["latencyMs"] ?? "?")}ms)`)}`);
    else warn(`Check failed: ${String(result["error"] ?? result["statusCode"] ?? "unknown")}`);
  });
}

export async function monitoringCheckGenerate(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const baseUrl = flagString(ctx.args, "base-url");
  const intervalMinutes = flagNumber(ctx.args, "every");

  const result = await withSpinner("Generating checks from the spec", () =>
    api.generateMonitoringChecks(ctx.client, projectId, {
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(intervalMinutes === undefined ? {} : { intervalMinutes }),
    }),
  );

  emit(result, () => {
    const created = result.created ?? 0;
    const updated = result.updated ?? 0;
    if (created + updated === 0) {
      warn("Nothing generated — every endpoint was skipped.");
      note("Checks are derived from safe operations only (GET/HEAD).");
      return;
    }
    success(
      `Generated ${created} new and updated ${updated} check(s) against ${bold(result.baseUrl ?? "the spec server")}.`,
    );
  });
}

export async function monitoringTestEvent(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const result = await withSpinner("Sending test event", () =>
    api.sendMonitoringTestEvent(ctx.client, projectId),
  );
  emit(result, () => {
    success("Test event delivered.");
    note("octri monitoring issues — it should appear within a few seconds.");
  });
}

// ─── Symbolication artifacts ──────────────────────────────────────────────────

interface Connection {
  url: string;
  token: string;
  environment: string;
  release: string;
}

/**
 * Resolves the upload connection: explicit flags and env vars win, and when they
 * are incomplete we ask the API for the project's ingest config. That ordering
 * is what lets the same command work unchanged in CI (three secrets, no login)
 * and on a laptop (no secrets, a signed-in session).
 */
async function resolveConnection(ctx: Context): Promise<Connection> {
  const flagUrl = flagString(ctx.args, "url") ?? process.env["MONITORING_URL"];
  // MONITORING_INGEST_TOKEN is a deprecated env-name alias, still read so CI
  // written against the old binary keeps working.
  const flagToken =
    flagString(ctx.args, "token") ??
    process.env["MONITORING_TOKEN"] ??
    process.env["MONITORING_INGEST_TOKEN"];
  const flagEnvironment =
    flagString(ctx.args, "environment") ?? process.env["MONITORING_ENVIRONMENT"];

  let url = flagUrl;
  let token = flagToken;
  let environment = flagEnvironment;

  if (url === undefined || token === undefined || environment === undefined) {
    if (!ctx.client.hasCredentials) {
      throw new Error(
        "Missing --url, --token or --environment, and no stored session to resolve them from. Run `octri auth login`, or pass all three (see `octri monitoring config`).",
      );
    }
    const config = await withSpinner("Resolving monitoring connection", () =>
      api.monitoringSdkConfig(ctx.client, ctx.projectId()),
    );
    url ??= config.baseUrl;
    token ??= config.token;
    environment ??= config.environment;
  }

  const release =
    flagString(ctx.args, "release") ??
    process.env["MONITORING_RELEASE"] ??
    gitRelease();

  const missing: string[] = [];
  if (url === undefined || url === "") missing.push("--url");
  if (token === undefined || token === "") missing.push("--token");
  if (environment === undefined || environment === "") missing.push("--environment");
  if (release === undefined || release === "") {
    missing.push("--release (or run inside a git repo)");
  }
  if (
    missing.length > 0 ||
    url === undefined ||
    token === undefined ||
    environment === undefined ||
    release === undefined
  ) {
    throw new Error(`Missing required: ${missing.join(", ")}`);
  }

  return { url, token, environment, release };
}

export async function monitoringSourcemapsUpload(ctx: Context): Promise<void> {
  await runUpload(ctx, "sourcemaps");
}

export async function monitoringSourcesUpload(ctx: Context): Promise<void> {
  await runUpload(ctx, "sources");
}

async function runUpload(ctx: Context, kind: "sourcemaps" | "sources"): Promise<void> {
  const connection = await resolveConnection(ctx);
  const dryRun = flagBool(ctx.args, "dry-run");
  const paths = ctx.args.positionals.length > 0 ? ctx.args.positionals : ["."];

  const noun = kind === "sourcemaps" ? "source map" : "source file";
  const result = await withSpinner(
    dryRun ? `Scanning for ${noun}s` : `Uploading ${noun}s`,
    () =>
      kind === "sourcemaps"
        ? uploadSourceMaps({ ...connection, paths, dryRun })
        : uploadSourceFiles({ ...connection, paths, dryRun }),
  );

  if (result.files.length === 0) {
    // Exit non-zero: a glob that matched nothing should fail the build rather
    // than pass quietly and leave production stacks unreadable.
    emit({ ...result, uploaded: 0 }, () =>
      warn(`No ${noun}s found under: ${paths.join(", ")}`),
    );
    process.exitCode = 1;
    return;
  }

  emit({ ...result, dryRun }, () => {
    if (dryRun) {
      heading(
        `Would upload ${result.files.length} ${noun}(s) ${dim(`· release ${shortRelease(result.release)}`)}`,
      );
    } else {
      success(
        `Uploaded ${result.stored} ${noun}(s) for release ${bold(shortRelease(result.release))} ${dim(`(environment ${result.environment})`)}`,
      );
    }
    for (const file of result.files.slice(0, 50)) line(dim(`  ${file}`));
    if (result.files.length > 50) {
      line(dim(`  … and ${result.files.length - 50} more`));
    }
  });
}

export async function monitoringSourcemapsList(ctx: Context): Promise<void> {
  await listArtifacts(ctx, "sourcemaps");
}

export async function monitoringSourcesList(ctx: Context): Promise<void> {
  await listArtifacts(ctx, "source-files");
}

async function listArtifacts(
  ctx: Context,
  kind: "sourcemaps" | "source-files",
): Promise<void> {
  const projectId = ctx.projectId();
  const release = flagString(ctx.args, "release");
  const rows = await withSpinner("Loading uploaded artifacts", () =>
    api.monitoringArtifacts(ctx.client, projectId, kind, release),
  );

  emit(rows, () => {
    heading(`Uploaded ${kind === "sourcemaps" ? "source maps" : "source files"} ${dim(`(${rows.length})`)}`);
    table(
      rows,
      [
        {
          header: "file",
          value: (r) => bold(r.filename ?? r.path ?? "—"),
          flex: 1,
          minWidth: 24,
        },
        { header: "release", value: (r) => dim(shortRelease(r.release)), flex: 4 },
        {
          header: "uploaded",
          value: (r) => relativeTime(r.uploadedAt ?? r.createdAt),
          flex: 6,
        },
      ],
      { emptyMessage: "Nothing uploaded for this release yet." },
    );
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Copies a flag into a query object only when it was supplied. */
function pickFlag(
  ctx: Context,
  flag: string,
  key = flag,
): Record<string, string> {
  const value = flagString(ctx.args, flag);
  return value === undefined ? {} : { [key]: value };
}

function requireArg(ctx: Context, usage: string): string {
  const value = ctx.args.positionals[0];
  if (value === undefined) throw new Error(`Usage: ${usage}`);
  return value;
}
