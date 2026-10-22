/**
 * `octri github …`: the spec-sync side of the GitHub integration: point a
 * project at a spec file in a repo, and every push to it re-ingests.
 *
 * The SDK-publishing side of GitHub lives under `octri sdk repos`, because it
 * is per-language and belongs with the generator.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath, sep } from "node:path";

import * as api from "../api.js";
import { flagBool, flagString } from "../args.js";
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
 * `octri github connect <owner/repo>`: `owner/repo` as one argument because
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
    note("octri github sync: pull the spec now");
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
        : `Synced. Spec is now ${bold(String(version))}.`,
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

// ─── Docs pull and sync ───────────────────────────────────────────────────────
//
// The connected repo's MDX and Markdown files. The API Studio's Files panel
// turns pulled files into page drafts; from a terminal they are written to
// disk. Sync on push rewrites page drafts only: Publish still gates readers.

/** `octri github docs`: the repo's docs files and the sync setting. */
export async function githubDocs(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const [status, listing] = await withSpinner("Loading repo docs", () =>
    Promise.all([
      api.githubStatus(ctx.client, projectId),
      api.listGithubDocsFiles(ctx.client, projectId),
    ]),
  );
  const sync = status.docsSync;

  emit({ projectId, docsSync: sync ?? null, ...listing }, () => {
    heading(`Docs in ${bold(`${listing.owner}/${listing.repo}`)} ${dim(listing.branch)}`);
    keyValues([
      ["sync on push", sync?.enabled === true ? green("on") : yellow("off")],
      ["folder", sync === undefined ? dim("not set") : sync.folder || dim("whole repo")],
      ["linked pages", String(sync?.links.length ?? 0)],
      ["last synced", relativeTime(sync?.lastSyncedAt)],
      ...(sync?.lastError === undefined
        ? []
        : ([["last error", red(sync.lastError)]] as const)),
    ]);
    line();
    table(
      listing.files,
      [
        { header: "file", value: (f) => f.path, flex: 1, minWidth: 20 },
        { header: "size", value: (f) => bytes(f.size), align: "right", flex: 6 },
      ],
      { emptyMessage: "No .mdx or .md files in the repo." },
    );
    if (listing.truncated) warn("The repo has more files than one listing returns.");
  });
}

/** The API reads at most this many files per request. */
const READ_BATCH = 50;

/**
 * `octri github docs pull [path…] [--out docs]`: writes the repo's docs files
 * under `--out`, keeping their repo paths. No paths pulls every listed file.
 */
export async function githubDocsPull(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const out = resolvePath(flagString(ctx.args, "out") ?? ".");
  let paths = [...ctx.args.positionals];
  if (paths.length === 0) {
    const listing = await withSpinner("Listing repo docs", () =>
      api.listGithubDocsFiles(ctx.client, projectId),
    );
    paths = listing.files.map((f) => f.path);
  }
  if (paths.length === 0) {
    warn("The repo has no .mdx or .md files to pull.");
    return;
  }

  const written: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (let i = 0; i < paths.length; i += READ_BATCH) {
    const batch = paths.slice(i, i + READ_BATCH);
    const result = await withSpinner(
      `Reading ${Math.min(i + READ_BATCH, paths.length)} of ${paths.length}`,
      () => api.readGithubDocsFiles(ctx.client, projectId, batch),
    );
    for (const file of result.files) {
      const target = resolvePath(out, file.path);
      // Repo paths come from the API, but a path still never leaves `--out`.
      if (target !== out && !target.startsWith(`${out}${sep}`)) {
        skipped.push({ path: file.path, reason: "outside_out" });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
      written.push(file.path);
    }
    skipped.push(...result.skipped);
  }

  emit({ projectId, out, written, skipped }, () => {
    success(`Pulled ${bold(String(written.length))} file(s) into ${bold(out)}`);
    for (const s of skipped) warn(`${s.path}: ${s.reason.replace(/_/g, " ")}`);
  });
}

/** `octri github docs sync <on|off> [--folder docs/]` */
export async function githubDocsSync(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const value = ctx.args.positionals[0];
  if (value !== "on" && value !== "off") {
    throw new Error("Usage: octri github docs sync <on|off> [--folder docs/]");
  }

  const folderFlag = flagString(ctx.args, "folder");
  const folder =
    folderFlag ?? (await api.githubStatus(ctx.client, projectId)).docsSync?.folder ?? "";

  const status = await withSpinner(`Turning docs sync ${value}`, () =>
    api.setGithubDocsSync(ctx.client, projectId, value === "on", folder),
  );
  const sync = status.docsSync;
  emit(status, () => {
    success(
      `Docs sync is ${sync?.enabled === true ? green("on") : yellow("off")}${sync?.enabled === true ? ` for ${bold(sync.folder || "the whole repo")}` : ""}.`,
    );
    if (sync?.enabled === true) {
      note("Pushes rewrite page drafts. Readers see them after you publish.");
    }
  });
}

/** `octri github app`: the dashboard-owned App, used for private repos. */
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
