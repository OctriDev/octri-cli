/**
 * `octri lab …` — the generator iteration loop.
 *
 * `lab run` is one command for the whole cycle: build every requested language,
 * watch the lanes, pull the artifacts down, extract them, and print a per-language
 * verdict with the failing output inline. `lab diff` then compares two runs so a
 * generator change can be judged by what actually changed in the emitted code.
 *
 * Runs are kept under `~/.octri/cache/lab/<project>/<buildId>` with a manifest,
 * which is what makes `diff` (and an agent reading the tree) possible later.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";

import { flagBool, flagList, flagNumber, flagString } from "../args.js";
import * as api from "../api.js";
import { cacheDir } from "../config.js";
import type { Context } from "../context.js";
import { extract } from "../archive.js";
import { bold, dim, green, red, yellow } from "../ui/ansi.js";
import { panel, rule, tree, treeFromPaths } from "../ui/box.js";
import {
  bytes,
  duration,
  emit,
  heading,
  keyValues,
  line,
  note,
  relativeTime,
  statusLabel,
  success,
  symbols,
  warn,
} from "../ui/output.js";
import { Spinner, TaskList, withSpinner, type TaskState } from "../ui/spinner.js";
import { table } from "../ui/table.js";

// ─── Run manifest ─────────────────────────────────────────────────────────────

interface LanguageOutcome {
  language: string;
  status: api.LangBuildStatus;
  errorMessage?: string;
  files: number;
  totalBytes: number;
  /** Content hash of the emitted tree — the unit `lab diff` compares. */
  fingerprint?: string;
  path?: string;
}

interface RunManifest {
  version: 1;
  projectId: string;
  buildId: string;
  buildVersion: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: api.BuildStatus;
  languages: LanguageOutcome[];
}

function labRoot(projectId: string): string {
  return join(cacheDir(), "lab", projectId);
}

function runDir(projectId: string, buildId: string): string {
  return join(labRoot(projectId), buildId);
}

function readManifest(projectId: string, buildId: string): RunManifest {
  const path = join(runDir(projectId, buildId), "manifest.json");
  if (!existsSync(path)) {
    throw new Error(
      `No local run for build ${buildId}. Run \`octri lab run\` or \`octri lab pull ${buildId}\` first.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as RunManifest;
}

// ─── lab run ──────────────────────────────────────────────────────────────────

/**
 * `octri lab run --lang go,rust,swift [--all] [--keep-going]`
 *
 * The full cycle. Exits non-zero when any requested language failed, so it drops
 * straight into a shell loop or CI step.
 */
export async function labRun(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const startedAt = Date.now();

  const languages = await resolveLanguages(ctx);
  const version = flagString(ctx.args, "version");

  heading(`Lab run ${dim(`${languages.length} languages`)}`);
  line(dim(`  project ${projectId}`));
  line();

  // 1. Validate first — a spec the generator rejects wastes a whole build.
  if (!flagBool(ctx.args, "skip-validate")) {
    const validation = await withSpinner(
      "Validating spec",
      () => api.validateSpec(ctx.client, projectId),
      { frames: "arc" },
    );
    const errors = validation.errors ?? [];
    if (errors.length > 0) {
      for (const error of errors.slice(0, 10)) {
        line(`  ${red(symbols.bullet)} ${error.message} ${dim(error.path ?? "")}`);
      }
      if (!flagBool(ctx.args, "keep-going")) {
        throw new Error(
          `Spec has ${errors.length} validation errors. Re-run with --keep-going to build anyway.`,
        );
      }
      warn(`Continuing past ${errors.length} validation errors.`);
    }
  }

  // 2. Trigger.
  const trigger = await withSpinner(
    `Queuing ${dim(languages.join(", "))}`,
    () =>
      api.triggerBuild(ctx.client, projectId, {
        languages,
        ...(version === undefined ? {} : { version }),
      }),
    { success: (r) => `Build ${bold(r.buildId)}` },
  );

  // 3. Watch the lanes.
  const lanes = new TaskList(
    languages.map((lang) => ({
      id: lang,
      label: lang.padEnd(9),
      state: "pending" as TaskState,
      detail: "queued",
    })),
  ).start();

  const build = await api.watchBuild(ctx.client, projectId, trigger.buildId, {
    intervalMs: flagNumber(ctx.args, "interval") ?? 2_000,
    onTick: (current) => {
      for (const artifact of current.artifacts) {
        lanes.add({
          id: artifact.languageId,
          label: artifact.languageId.padEnd(9),
          state: "pending",
        });
        lanes.set(artifact.languageId, {
          state:
            artifact.status === "failed"
              ? "failed"
              : artifact.status === "ready" || artifact.status === "verified"
                ? "done"
                : artifact.status === "queued"
                  ? "pending"
                  : "running",
          detail:
            artifact.status === "failed"
              ? (artifact.errorMessage ?? "failed").split("\n")[0]?.slice(0, 64)
              : `${artifact.status}…`,
        });
      }
    },
  });
  lanes.stop();

  // 4. Pull + extract everything that shipped.
  const outcomes = await collectOutcomes(ctx, projectId, build);

  const manifest: RunManifest = {
    version: 1,
    projectId,
    buildId: build.id,
    buildVersion: build.version,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    status: build.status,
    languages: outcomes,
  };

  const destination = runDir(projectId, build.id);
  mkdirSync(destination, { recursive: true });
  writeFileSync(
    join(destination, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  // 5. Report.
  emit(manifest, () => renderRunReport(manifest, destination));

  const failed = outcomes.filter((o) => o.status === "failed");
  if (failed.length > 0) process.exitCode = 1;
}

/** `octri lab pull <buildId>` — fetch + extract a build that already ran. */
export async function labPull(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const buildId = ctx.args.positionals[0];
  if (buildId === undefined) throw new Error("Usage: octri lab pull <buildId>");

  const build = await api.findBuild(ctx.client, projectId, buildId);
  if (build === undefined) throw new Error(`Build ${buildId} not found.`);

  const outcomes = await collectOutcomes(ctx, projectId, build);
  const destination = runDir(projectId, build.id);
  mkdirSync(destination, { recursive: true });

  const manifest: RunManifest = {
    version: 1,
    projectId,
    buildId: build.id,
    buildVersion: build.version,
    startedAt: build.createdAt,
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    status: build.status,
    languages: outcomes,
  };
  writeFileSync(
    join(destination, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  emit(manifest, () => renderRunReport(manifest, destination));
}

/** `octri lab runs` — what is cached locally for this project. */
export function labRuns(ctx: Context): void {
  const projectId = ctx.projectId();
  const root = labRoot(projectId);

  const runs = existsSync(root)
    ? readdirSync(root)
        .map((id) => {
          try {
            return readManifest(projectId, id);
          } catch {
            return undefined;
          }
        })
        .filter((m): m is RunManifest => m !== undefined)
        .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
    : [];

  emit({ projectId, runs }, () => {
    heading(`Local runs ${dim(`(${runs.length})`)}`);
    table(
      runs,
      [
        { header: "build", value: (r) => dim(r.buildId), flex: 8, minWidth: 24 },
        { header: "version", value: (r) => bold(r.buildVersion), flex: 4 },
        { header: "status", value: (r) => statusLabel(r.status), flex: 5 },
        {
          header: "langs",
          value: (r) =>
            r.languages
              .map((l) => (l.status === "failed" ? red(l.language) : green(l.language)))
              .join(" "),
          flex: 1,
          minWidth: 18,
        },
        { header: "took", value: (r) => duration(r.durationMs), align: "right", flex: 6 },
        { header: "when", value: (r) => relativeTime(r.finishedAt), flex: 5 },
      ],
      { emptyMessage: "No cached runs — `octri lab run --lang go`." },
    );
    if (runs.length > 0) note(`Cached under ${root}`);
  });
}

/** `octri lab files <buildId> --lang go` — the emitted tree for one language. */
export function labFiles(ctx: Context): void {
  const projectId = ctx.projectId();
  const buildId = ctx.args.positionals[0];
  if (buildId === undefined) {
    throw new Error("Usage: octri lab files <buildId> --lang <language>");
  }
  const language = flagString(ctx.args, "lang");
  if (language === undefined) throw new Error("Pass --lang <language>.");

  const root = join(runDir(projectId, buildId), language);
  if (!existsSync(root)) {
    throw new Error(`No extracted output for ${language} in build ${buildId}.`);
  }

  const files = walk(root).map((path) => ({
    path: relative(root, path).split(sep).join("/"),
    size: statSync(path).size,
  }));

  emit({ buildId, language, root, files }, () => {
    heading(`${language} ${dim(`— ${files.length} files`)}`);
    tree(treeFromPaths(files.map((f) => ({ path: f.path, detail: bytes(f.size) }))));
    note(`Read one with: octri lab cat ${buildId} --lang ${language} --file <path>`);
  });
}

/** `octri lab cat <buildId> --lang go --file src/client.go`. */
export function labCat(ctx: Context): void {
  const projectId = ctx.projectId();
  const buildId = ctx.args.positionals[0];
  const language = flagString(ctx.args, "lang");
  const file = flagString(ctx.args, "file");

  if (buildId === undefined || language === undefined || file === undefined) {
    throw new Error(
      "Usage: octri lab cat <buildId> --lang <language> --file <path>",
    );
  }

  const root = join(runDir(projectId, buildId), language);
  const matches = walk(root).filter((path) => {
    const rel = relative(root, path).split(sep).join("/");
    return rel === file || rel.endsWith(`/${file}`) || rel.endsWith(file);
  });

  const target = matches[0];
  if (target === undefined) throw new Error(`No file matching "${file}".`);

  const content = readFileSync(target, "utf8");
  const rel = relative(root, target).split(sep).join("/");

  emit({ buildId, language, path: rel, content }, () => {
    rule(rel);
    line(content);
  });
}

// ─── lab diff ─────────────────────────────────────────────────────────────────

/**
 * `octri lab diff <buildA> <buildB> [--lang go]`
 *
 * Compares two cached runs file-by-file. This is the actual test for a generator
 * change: which emitted files appeared, vanished, or changed, per language.
 */
export function labDiff(ctx: Context): void {
  const projectId = ctx.projectId();
  const [idA, idB] = ctx.args.positionals;
  if (idA === undefined || idB === undefined) {
    throw new Error("Usage: octri lab diff <buildA> <buildB> [--lang go]");
  }

  const manifestA = readManifest(projectId, idA);
  const manifestB = readManifest(projectId, idB);
  const only = flagString(ctx.args, "lang");

  const languages = [
    ...new Set([
      ...manifestA.languages.map((l) => l.language),
      ...manifestB.languages.map((l) => l.language),
    ]),
  ].filter((lang) => only === undefined || lang === only);

  const report = languages.map((language) => {
    const filesA = fileMap(join(runDir(projectId, idA), language));
    const filesB = fileMap(join(runDir(projectId, idB), language));

    const added = [...filesB.keys()].filter((p) => !filesA.has(p)).sort();
    const removed = [...filesA.keys()].filter((p) => !filesB.has(p)).sort();
    const changed = [...filesB.keys()]
      .filter((p) => filesA.has(p) && filesA.get(p) !== filesB.get(p))
      .sort();

    return { language, added, removed, changed, unchanged: filesB.size - added.length - changed.length };
  });

  emit({ from: idA, to: idB, languages: report }, () => {
    heading(`Diff ${dim(`${idA.slice(-8)} → ${idB.slice(-8)}`)}`);

    for (const entry of report) {
      const total = entry.added.length + entry.removed.length + entry.changed.length;
      line();
      line(
        `  ${bold(entry.language)} ${
          total === 0
            ? dim("identical")
            : `${green(`+${entry.added.length}`)} ${red(`-${entry.removed.length}`)} ${yellow(`~${entry.changed.length}`)} ${dim(`${entry.unchanged} unchanged`)}`
        }`,
      );
      for (const path of entry.added.slice(0, 20)) line(`    ${green("+")} ${path}`);
      for (const path of entry.removed.slice(0, 20)) line(`    ${red("-")} ${path}`);
      for (const path of entry.changed.slice(0, 20)) line(`    ${yellow("~")} ${path}`);
      const hidden = total - Math.min(20, entry.added.length) - Math.min(20, entry.removed.length) - Math.min(20, entry.changed.length);
      if (hidden > 0) note(`    …and ${hidden} more`);
    }
  });
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function resolveLanguages(ctx: Context): Promise<string[]> {
  if (flagBool(ctx.args, "all")) {
    const catalogue = await api.listLanguages(ctx.client);
    return catalogue.map((l) => l.id);
  }
  const explicit = flagList(ctx.args, "lang");
  if (explicit.length > 0) return explicit;
  if (ctx.settings.defaultLanguages.length > 0) return ctx.settings.defaultLanguages;

  throw new Error(
    "Pick languages: --lang go,rust  ·  --all  ·  or `octri config set defaultLanguages go,rust`.",
  );
}

/** Downloads + extracts each shipped artifact and fingerprints the tree. */
async function collectOutcomes(
  ctx: Context,
  projectId: string,
  build: api.Build,
): Promise<LanguageOutcome[]> {
  const artifacts = await api.listArtifacts(ctx.client, projectId, build.id);
  const byLanguage = new Map(artifacts.map((a) => [a.language, a]));
  const destination = runDir(projectId, build.id);
  const outcomes: LanguageOutcome[] = [];

  for (const lane of build.artifacts) {
    if (lane.status === "failed") {
      outcomes.push({
        language: lane.languageId,
        status: lane.status,
        ...(lane.errorMessage === undefined ? {} : { errorMessage: lane.errorMessage }),
        files: 0,
        totalBytes: 0,
      });
      continue;
    }

    const artifact = byLanguage.get(lane.languageId);
    if (artifact?.url === undefined) {
      outcomes.push({
        language: lane.languageId,
        status: lane.status,
        files: 0,
        totalBytes: 0,
      });
      continue;
    }

    const spinner = new Spinner(
      `Pulling ${bold(lane.languageId)} ${dim(bytes(artifact.fileSizeBytes))}`,
    ).start();

    try {
      const response = await ctx.client.fetchRaw(artifact.url);
      const buffer = Buffer.from(await response.arrayBuffer());
      const target = join(destination, lane.languageId);
      const files = extract(buffer, target, artifact.url);
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

      outcomes.push({
        language: lane.languageId,
        status: lane.status,
        files: files.length,
        totalBytes,
        fingerprint: fingerprint(fileMap(target)),
        path: target,
      });
      spinner.succeed(
        `${bold(lane.languageId)} ${dim(`${files.length} files, ${bytes(totalBytes)}`)}`,
      );
    } catch (err) {
      spinner.warnWith(`${lane.languageId}: ${(err as Error).message}`);
      outcomes.push({
        language: lane.languageId,
        status: lane.status,
        errorMessage: (err as Error).message,
        files: 0,
        totalBytes: 0,
      });
    }
  }

  return outcomes;
}

function renderRunReport(manifest: RunManifest, destination: string): void {
  line();
  rule("result");
  keyValues([
    ["build", manifest.buildId],
    ["version", manifest.buildVersion],
    ["status", statusLabel(manifest.status)],
    ["took", duration(manifest.durationMs)],
  ]);
  line();

  table(manifest.languages, [
    {
      header: "language",
      value: (l) =>
        l.status === "failed" ? red(l.language) : bold(l.language),
      flex: 4,
    },
    { header: "status", value: (l) => statusLabel(l.status), flex: 5 },
    { header: "files", value: (l) => String(l.files || ""), align: "right", flex: 6 },
    {
      header: "size",
      value: (l) => (l.totalBytes > 0 ? bytes(l.totalBytes) : dim("—")),
      align: "right",
      flex: 6,
    },
    {
      header: "fingerprint",
      value: (l) => dim(l.fingerprint?.slice(0, 12) ?? "—"),
      flex: 3,
    },
  ]);

  const failed = manifest.languages.filter((l) => l.status === "failed");
  for (const outcome of failed) {
    line();
    panel((outcome.errorMessage ?? "No error message returned.").split("\n").slice(0, 14), {
      title: `${red(outcome.language)} failed`,
    });
  }

  line();
  if (failed.length === 0) {
    success(`All ${manifest.languages.length} languages emitted.`);
  } else {
    line(
      `${red(symbols.fail)} ${failed.length} of ${manifest.languages.length} failed: ${failed.map((f) => f.language).join(", ")}`,
    );
    note(
      `octri sdk retry ${manifest.buildId} --lang ${failed.map((f) => f.language).join(",")}`,
    );
  }
  note(`Sources under ${destination}`);
  note(`Compare with a previous run: octri lab diff <olderBuildId> ${manifest.buildId}`);
}

/** Recursively lists files under `root` (absolute paths). */
function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** relative path → content hash, the basis for both diff and fingerprint. */
function fileMap(root: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const path of walk(root)) {
    const rel = relative(root, path).split(sep).join("/");
    map.set(rel, createHash("sha256").update(readFileSync(path)).digest("hex"));
  }
  return map;
}

/** Stable hash of an entire emitted tree (paths + contents). */
function fingerprint(files: Map<string, string>): string {
  const hash = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    hash.update(path).update("\0").update(files.get(path) ?? "").update("\n");
  }
  return hash.digest("hex");
}

/** Re-exported for the MCP layer, which needs the same cache locations. */
export const labPaths = { labRoot, runDir, readManifest, walk, fileMap };
