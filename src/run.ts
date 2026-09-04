/**
 * The `octri` router — parse, route, render.
 *
 * Global flags are applied before anything runs so `--json` suppresses even the
 * banner, and every error funnels through one handler that knows how to turn an
 * API failure into an actionable sentence.
 *
 * `run` takes argv rather than reading `process.argv` so anything embedding the
 * CLI can drive it without touching process state.
 */

import { flagBool, flagString, parse } from "./args.js";
import { ApiError, NotAuthenticatedError } from "./client.js";
import * as auth from "./commands/auth.js";
import * as configCmd from "./commands/config.js";
import * as docs from "./commands/docs.js";
import * as lab from "./commands/lab.js";
import * as github from "./commands/github.js";
import * as jobs from "./commands/jobs.js";
import * as keys from "./commands/keys.js";
import * as monitoring from "./commands/monitoring.js";
import * as orgs from "./commands/orgs.js";
import * as projects from "./commands/projects.js";
import * as sdk from "./commands/sdk.js";
import * as specs from "./commands/specs.js";
import { createContext, type Context } from "./context.js";
import { printHelp } from "./help.js";
import { cursor, dim } from "./ui/ansi.js";
import { write, configureOutput, fail, line, note } from "./ui/output.js";
import { NonInteractiveError } from "./ui/prompt.js";

const VERSION = "0.1.0";

type Handler = (ctx: Context) => void | Promise<void>;

/**
 * Command table, keyed by `"<group> <verb>"`. A group's default verb is listed
 * under the bare group name so `octri projects` behaves like `octri projects list`.
 */
const ROUTES: Record<string, Handler> = {
  // auth
  auth: auth.authWhoami,
  "auth login": auth.authLogin,
  "auth logout": auth.authLogout,
  "auth whoami": auth.authWhoami,
  "auth token": (ctx) => auth.authToken(ctx),
  "auth profiles": () => auth.authProfiles(),

  // config
  config: configCmd.configList,
  "config list": configCmd.configList,
  "config set": (ctx) => configCmd.configSet(ctx.args),
  "config use": (ctx) => configCmd.configUse(ctx.args),
  "config path": () => configCmd.configPathCommand(),

  // projects
  projects: projects.projectsList,
  "projects list": projects.projectsList,
  "projects show": projects.projectsShow,
  "projects create": projects.projectsCreate,
  "projects use": projects.projectsUse,
  "projects current": projects.projectsCurrent,

  // specs
  specs: specs.specsList,
  "specs list": specs.specsList,
  "specs push": specs.specsPush,
  "specs import": specs.specsImport,
  "specs status": specs.specsStatus,
  "specs delete": specs.specsDelete,

  // sdk
  sdk: sdk.sdkBuilds,
  "sdk languages": sdk.sdkLanguages,
  "sdk operations": sdk.sdkOperations,
  "sdk validate": sdk.sdkValidate,
  "sdk audit": sdk.sdkAudit,
  "sdk preview": sdk.sdkPreview,
  "sdk build": sdk.sdkBuild,
  "sdk builds": sdk.sdkBuilds,
  "sdk watch": sdk.sdkWatch,
  "sdk artifacts": sdk.sdkArtifacts,
  "sdk download": sdk.sdkDownload,
  "sdk retry": sdk.sdkRetry,
  "sdk publish": sdk.sdkPublish,
  "sdk repos": sdk.sdkRepos,
  "sdk stats": sdk.sdkStats,

  // lab
  lab: lab.labRuns,
  "lab run": lab.labRun,
  "lab runs": (ctx) => lab.labRuns(ctx),
  "lab pull": lab.labPull,
  "lab files": (ctx) => lab.labFiles(ctx),
  "lab cat": (ctx) => lab.labCat(ctx),
  "lab diff": (ctx) => lab.labDiff(ctx),

  // orgs & access
  orgs: orgs.orgsList,
  "orgs list": orgs.orgsList,
  "orgs show": orgs.orgsShow,
  "orgs usage": orgs.orgsUsage,
  "orgs switch": orgs.orgsSwitch,
  "orgs billing": orgs.orgsBilling,
  "orgs invoices": orgs.orgsInvoices,
  keys: keys.keysList,
  "keys list": keys.keysList,
  "keys create": keys.keysCreate,
  "keys revoke": keys.keysRevoke,

  // github spec sync
  github: github.githubStatus,
  "github status": github.githubStatus,
  "github connect": github.githubConnect,
  "github disconnect": github.githubDisconnect,
  "github sync": github.githubSync,
  "github auto-sync": github.githubAutoSync,
  "github app": github.githubApp,

  // jobs
  jobs: jobs.jobsList,
  "jobs list": jobs.jobsList,
  "jobs show": jobs.jobsShow,

  // monitoring
  monitoring: monitoring.monitoringSummary,
  "monitoring status": monitoring.monitoringStatus,
  "monitoring enable": monitoring.monitoringEnable,
  "monitoring disable": monitoring.monitoringDisable,
  "monitoring config": monitoring.monitoringConfig,
  "monitoring summary": monitoring.monitoringSummary,
  "monitoring issues": monitoring.monitoringIssues,
  "monitoring issue": monitoring.monitoringIssue,
  "monitoring resolve": monitoring.monitoringResolve,
  "monitoring ignore": monitoring.monitoringIgnore,
  "monitoring reopen": monitoring.monitoringReopen,
  "monitoring comment": monitoring.monitoringComment,
  "monitoring logs": monitoring.monitoringLogs,
  "monitoring traces": monitoring.monitoringTraces,
  "monitoring performance": monitoring.monitoringPerformance,
  "monitoring releases": monitoring.monitoringReleases,
  "monitoring test-event": monitoring.monitoringTestEvent,

  // docs / mcp
  docs: docs.docsPages,
  "docs pages": docs.docsPages,
  "docs show": docs.docsShow,
  "docs changelog": docs.docsChangelog,
  "mcp tools": docs.mcpTools,
};

/**
 * Three-token commands (`<group> <verb> <action>`), dispatched before the main
 * table because `parse` only treats the first two tokens as the command path.
 *
 * A group's `default` is what a bare `octri sdk repos` runs; anything else must
 * name a known action, so a typo is an error instead of a silently wrong list.
 */
interface SubGroup {
  default: string;
  actions: Record<string, Handler>;
}

const SUBROUTES: Record<string, SubGroup> = {
  "sdk settings": {
    default: "get",
    actions: { get: sdk.sdkSettingsGet, set: sdk.sdkSettingsSet },
  },
  "sdk repos": {
    default: "list",
    actions: { list: sdk.sdkRepos, init: sdk.sdkReposInit },
  },
  "sdk audit": {
    default: "report",
    actions: {
      report: sdk.sdkAudit,
      apply: sdk.sdkAuditApply,
      ignore: sdk.sdkAuditIgnore,
    },
  },
  "monitoring sourcemaps": {
    default: "list",
    actions: {
      list: monitoring.monitoringSourcemapsList,
      upload: monitoring.monitoringSourcemapsUpload,
    },
  },
  "monitoring sources": {
    default: "list",
    actions: {
      list: monitoring.monitoringSourcesList,
      upload: monitoring.monitoringSourcesUpload,
    },
  },
  "monitoring alerts": {
    default: "list",
    actions: {
      list: monitoring.monitoringAlerts,
      create: monitoring.monitoringAlertCreate,
      delete: monitoring.monitoringAlertDelete,
      evaluate: monitoring.monitoringAlertEvaluate,
    },
  },
  "monitoring checks": {
    default: "list",
    actions: {
      list: monitoring.monitoringChecks,
      run: monitoring.monitoringCheckRun,
      generate: monitoring.monitoringCheckGenerate,
    },
  },
  "orgs members": {
    default: "list",
    actions: {
      list: orgs.orgMembers,
      role: orgs.orgMemberRole,
      remove: orgs.orgMemberRemove,
    },
  },
  "orgs invites": {
    default: "list",
    actions: {
      list: orgs.orgInvites,
      create: orgs.orgInviteCreate,
      resend: orgs.orgInviteResend,
      revoke: orgs.orgInviteRevoke,
    },
  },
  "docs pages": {
    default: "list",
    actions: {
      list: docs.docsPages,
      generate: docs.docsGenerate,
      regenerate: docs.docsRegenerate,
      publish: docs.docsPublishDraft,
      title: docs.docsSetTitle,
    },
  },
  "docs nav": {
    default: "show",
    actions: { show: docs.docsNav, publish: docs.docsNavPublish },
  },
  "docs guides": {
    default: "list",
    actions: {
      list: docs.docsGuides,
      show: docs.docsGuideShow,
      publish: docs.docsGuidePublish,
    },
  },
  "docs domain": {
    default: "show",
    actions: {
      show: docs.docsDomain,
      set: docs.docsDomainSet,
      verify: docs.docsDomainVerify,
      remove: docs.docsDomainRemove,
    },
  },
  "docs versions": {
    default: "list",
    actions: {
      list: docs.docsVersions,
      publish: docs.docsVersionPublish,
      unpublish: docs.docsVersionUnpublish,
      label: docs.docsVersionLabel,
      default: docs.docsVersionDefault,
    },
  },
};

async function routeSub(ctx: Context): Promise<boolean> {
  const [group, verb] = ctx.args.command;
  if (group === undefined) return false;

  if (verb === undefined) return false;
  const sub = SUBROUTES[`${group} ${verb}`];
  if (sub === undefined) return false;

  const requested = ctx.args.positionals[0];
  const action = requested ?? sub.default;
  const handler = sub.actions[action];

  if (handler === undefined) {
    throw new Error(
      `Usage: octri ${group} ${verb} <${Object.keys(sub.actions).join("|")}>`,
    );
  }
  if (requested !== undefined) ctx.args.positionals.shift();

  await handler(ctx);
  return true;
}

export async function run(argv: readonly string[]): Promise<void> {
  const args = parse(argv);

  configureOutput({
    json: flagBool(args, "json"),
    quiet: flagBool(args, "quiet"),
    plain: flagBool(args, "plain"),
  });

  if (flagBool(args, "version")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const [group, verb] = args.command;

  if (group === undefined || flagBool(args, "help") || group === "help") {
    // `octri help sdk` and `octri sdk --help` should both land on one group;
    // a bare `octri --help` has no topic and prints everything.
    printHelp(group === "help" ? (verb ?? args.positionals[0]) : group);
    return;
  }

  // `mcp serve` never builds a terminal context: stdout belongs to the protocol.
  if (group === "mcp" && verb === "serve") {
    const { serve } = await import("./mcp/server.js");
    const profile = flagString(args, "profile");
    const apiUrl = flagString(args, "api-url");
    const project = flagString(args, "project");
    await serve({
      ...(profile === undefined ? {} : { profile }),
      ...(apiUrl === undefined ? {} : { apiUrl }),
      ...(project === undefined ? {} : { project }),
      allowPublish: flagBool(args, "allow-publish"),
      allowDelete: flagBool(args, "allow-delete"),
    });
    return;
  }

  const ctx = createContext(args);

  if (await routeSub(ctx)) return;

  const handler =
    ROUTES[verb === undefined ? group : `${group} ${verb}`] ?? ROUTES[group];

  if (handler === undefined) {
    fail(`Unknown command: ${[group, verb].filter(Boolean).join(" ")}`);
    note("Run `octri --help` for the full list.");
    process.exitCode = 1;
    return;
  }

  await handler(ctx);
}

// ─── Error handling ───────────────────────────────────────────────────────────

export function report(err: unknown): void {
  // Always restore the cursor — a spinner may have hidden it mid-flight.
  write(cursor.show);

  if (err instanceof NotAuthenticatedError) {
    fail(err.message);
    note("octri auth login");
    process.exitCode = 1;
    return;
  }

  if (err instanceof NonInteractiveError) {
    fail(err.message);
    process.exitCode = 1;
    return;
  }

  if (err instanceof ApiError) {
    fail(err.message);
    line(
      dim(
        `  ${err.code}${err.status > 0 ? ` · HTTP ${err.status}` : ""} · ${err.path}`,
      ),
    );
    if (err.status === 401) note("octri auth login");
    if (err.status === 403) note("The plan or your role may not allow this.");
    if (err.code === "NETWORK") {
      note("Check the API is running: octri config list");
    }
    process.exitCode = 1;
    return;
  }

  fail((err as Error).message ?? String(err));
  if (process.env.OCTRI_DEBUG !== undefined) {
    line(dim(String((err as Error).stack ?? "")));
  }
  process.exitCode = 1;
}

