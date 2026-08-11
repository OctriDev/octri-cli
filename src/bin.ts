#!/usr/bin/env node

/**
 * `octri` entry point — parse, route, render, exit.
 *
 * Global flags are applied before anything runs so `--json` suppresses even the
 * banner, and every error funnels through one handler that knows how to turn an
 * API failure into an actionable sentence.
 */

import { flagBool, flagString, parse } from "./args.js";
import { ApiError, NotAuthenticatedError } from "./client.js";
import { createContext, type Context } from "./context.js";
import { printHelp } from "./help.js";
import { NonInteractiveError } from "./ui/prompt.js";
import { configureOutput, fail, line, note } from "./ui/output.js";
import { cursor, dim } from "./ui/ansi.js";
import { write } from "./ui/output.js";

import * as auth from "./commands/auth.js";
import * as configCmd from "./commands/config.js";
import * as docs from "./commands/docs.js";
import * as lab from "./commands/lab.js";
import * as projects from "./commands/projects.js";
import * as sdk from "./commands/sdk.js";
import * as specs from "./commands/specs.js";

const VERSION = "0.1.0";

type Handler = (ctx: Context) => void | Promise<void>;

/**
 * Command table, keyed by `"<group> <verb>"`. A group's default verb is listed
 * under the bare group name so `octri projects` behaves like `octri projects list`.
 */
const ROUTES: Record<string, Handler> = {
  // auth
  "auth": auth.authWhoami,
  "auth login": auth.authLogin,
  "auth logout": auth.authLogout,
  "auth whoami": auth.authWhoami,
  "auth token": (ctx) => auth.authToken(ctx),
  "auth profiles": () => auth.authProfiles(),

  // config
  "config": configCmd.configList,
  "config list": configCmd.configList,
  "config set": (ctx) => configCmd.configSet(ctx.args),
  "config use": (ctx) => configCmd.configUse(ctx.args),
  "config path": () => configCmd.configPathCommand(),

  // projects
  "projects": projects.projectsList,
  "projects list": projects.projectsList,
  "projects show": projects.projectsShow,
  "projects create": projects.projectsCreate,
  "projects use": projects.projectsUse,
  "projects current": projects.projectsCurrent,

  // specs
  "specs": specs.specsList,
  "specs list": specs.specsList,
  "specs push": specs.specsPush,
  "specs import": specs.specsImport,
  "specs status": specs.specsStatus,
  "specs delete": specs.specsDelete,

  // sdk
  "sdk": sdk.sdkBuilds,
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
  "lab": lab.labRuns,
  "lab run": lab.labRun,
  "lab runs": (ctx) => lab.labRuns(ctx),
  "lab pull": lab.labPull,
  "lab files": (ctx) => lab.labFiles(ctx),
  "lab cat": (ctx) => lab.labCat(ctx),
  "lab diff": (ctx) => lab.labDiff(ctx),

  // docs / mcp
  "docs": docs.docsPages,
  "docs pages": docs.docsPages,
  "docs show": docs.docsShow,
  "docs changelog": docs.docsChangelog,
  "mcp tools": docs.mcpTools,
};

/** `sdk settings get|set` is three tokens deep; handled before the table. */
async function routeSettings(ctx: Context): Promise<boolean> {
  const [group, verb] = ctx.args.command;
  if (group !== "sdk" || verb !== "settings") return false;

  const action = ctx.args.positionals[0] ?? "get";
  // Shift the action off so the command sees only its own arguments.
  ctx.args.positionals.shift();

  if (action === "get") await sdk.sdkSettingsGet(ctx);
  else if (action === "set") await sdk.sdkSettingsSet(ctx);
  else throw new Error("Usage: octri sdk settings <get|set>");

  return true;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
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
    printHelp(verb ?? args.positionals[0]);
    return;
  }

  // `mcp serve` never builds a terminal context: stdout belongs to the protocol.
  if (group === "mcp" && verb === "serve") {
    const { serve } = await import("./mcp/server.js");
    await serve({
      ...(flagString(args, "profile") === undefined
        ? {}
        : { profile: flagString(args, "profile") as string }),
      ...(flagString(args, "api-url") === undefined
        ? {}
        : { apiUrl: flagString(args, "api-url") as string }),
      ...(flagString(args, "project") === undefined
        ? {}
        : { project: flagString(args, "project") as string }),
      allowPublish: flagBool(args, "allow-publish"),
      allowDelete: flagBool(args, "allow-delete"),
    });
    return;
  }

  const ctx = createContext(args);

  if (await routeSettings(ctx)) return;

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

function report(err: unknown): void {
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
    line(dim(`  ${err.code}${err.status > 0 ? ` · HTTP ${err.status}` : ""} · ${err.path}`));
    if (err.status === 401) note("octri auth login");
    if (err.status === 403) note("The plan or your role may not allow this.");
    if (err.code === "NETWORK") {
      note("Check the API is running: octri config list");
    }
    process.exitCode = 1;
    return;
  }

  fail((err as Error).message ?? String(err));
  if (process.env["OCTRI_DEBUG"] !== undefined) {
    line(dim(String((err as Error).stack ?? "")));
  }
  process.exitCode = 1;
}

process.on("SIGINT", () => {
  write(cursor.show);
  process.exit(130);
});

main().catch(report);
