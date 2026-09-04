/**
 * `octri github …` — the spec-sync side of the GitHub integration: point a
 * project at a spec file in a repo, and every push to it re-ingests.
 *
 * The SDK-publishing side of GitHub lives under `octri sdk repos`, because it
 * is per-language and belongs with the generator.
 */

import * as api from "../api.js";
import { flagBool, flagString } from "../args.js";
import { bold, dim, green, yellow } from "../ui/ansi.js";
import {
  emit,
  heading,
  keyValues,
  note,
  relativeTime,
  success,
  warn,
} from "../ui/output.js";
import { withSpinner } from "../ui/spinner.js";

import type { Context } from "../context.js";

export async function githubStatus(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const status = await withSpinner("Loading GitHub connection", () =>
    api.githubStatus(ctx.client, projectId),
  );

  emit(status, () => {
    heading("GitHub spec sync");
    if (!status.connected) {
      keyValues([["status", dim("not connected")]]);
      note("octri github connect <owner/repo> --branch main --path openapi.yaml");
      return;
    }
    keyValues([
      ["repo", bold(`${status.owner}/${status.repo}`)],
      ["branch", status.branch ?? "—"],
      ["spec path", status.specPath ?? "—"],
      ["auto-sync", status.autoSync ? green("on") : yellow("off")],
      ["reverse sync", status.reverseSyncSpec === true ? green("on") : dim("off")],
      ["webhook", status.webhookId ?? dim("none")],
      ["last synced", relativeTime(status.lastSyncedAt)],
      ["last sha", status.lastSyncedSha?.slice(0, 12) ?? dim("—")],
    ]);
  });
}

/**
 * `octri github connect <owner/repo>` — `owner/repo` as one argument because
 * that is how people copy it out of a browser address bar.
 */
export async function githubConnect(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const target = ctx.args.positionals[0];
  if (target === undefined || !target.includes("/")) {
    throw new Error(
      "Usage: octri github connect <owner/repo> [--branch main] [--path openapi.yaml]",
    );
  }
  const [owner, repo] = target.split("/", 2);
  if (owner === undefined || repo === undefined || repo === "") {
    throw new Error("Repository must be given as <owner>/<repo>.");
  }

  const body = {
    owner,
    repo,
    branch: flagString(ctx.args, "branch") ?? "main",
    specPath: flagString(ctx.args, "path") ?? "openapi.yaml",
  };

  const status = await withSpinner(`Connecting ${bold(target)}`, () =>
    api.githubConnect(ctx.client, projectId, body),
  );
  emit(status, () => {
    success(`Connected ${bold(`${owner}/${repo}`)} (${body.branch}:${body.specPath})`);
    note("octri github sync — pull the spec now");
  });
}

export async function githubDisconnect(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  if (!flagBool(ctx.args, "yes")) {
    warn("Disconnecting removes the webhook. Re-run with --yes to confirm.");
    return;
  }
  await withSpinner("Disconnecting", () =>
    api.githubDisconnect(ctx.client, projectId),
  );
  emit({ disconnected: true }, () => success("GitHub disconnected."));
}

export async function githubSync(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const result = await withSpinner("Pulling the spec from GitHub", () =>
    api.githubSyncNow(ctx.client, projectId),
  );
  emit(result, () => {
    const version = result["version"] ?? result["specVersion"];
    success(
      version === undefined
        ? "Sync complete."
        : `Synced — spec is now ${bold(String(version))}.`,
    );
  });
}

/** `octri github auto-sync on|off`. */
export async function githubAutoSync(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const value = ctx.args.positionals[0];
  if (value !== "on" && value !== "off") {
    throw new Error("Usage: octri github auto-sync <on|off>");
  }

  const status = await withSpinner(`Turning auto-sync ${value}`, () =>
    api.githubSyncToggle(ctx.client, projectId, value === "on"),
  );
  emit(status, () =>
    success(`Auto-sync is ${status.autoSync ? green("on") : yellow("off")}.`),
  );
}

/** `octri github app` — the dashboard-owned App, used for private repos. */
export async function githubApp(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const status = await withSpinner("Loading GitHub App status", () =>
    api.githubAppStatus(ctx.client, projectId),
  );
  emit(status, () => {
    heading("GitHub App");
    keyValues(
      Object.entries(status)
        .filter(([, v]) => typeof v !== "object" || v === null)
        .map(([k, v]) => [k, String(v)] as const),
    );
  });
}
