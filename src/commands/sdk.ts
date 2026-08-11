/**
 * `octri sdk …` — the SDK Studio and the generator, from a terminal.
 *
 * This is the surface the CLI exists for: trigger builds, watch every language
 * lane live, pull the artifacts down, and read what the generator actually
 * emitted — without opening the dashboard.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { flagBool, flagList, flagNumber, flagString } from "../args.js";
import * as api from "../api.js";
import { cacheDir } from "../config.js";
import type { Context } from "../context.js";
import { extract } from "../archive.js";
import {
  accent,
  bold,
  cyan,
  dim,
  gray,
  green,
  red,
  yellow,
} from "../ui/ansi.js";
import { panel, rule, tree, treeFromPaths } from "../ui/box.js";
import {
  bytes,
  duration,
  emit,
  heading,
  isStatic,
  keyValues,
  line,
  note,
  relativeTime,
  statusLabel,
  success,
  symbols,
  warn,
} from "../ui/output.js";
import { sparkline } from "../ui/progress.js";
import { Spinner, TaskList, withSpinner, type TaskState } from "../ui/spinner.js";
import { table } from "../ui/table.js";

// ─── Catalogue ────────────────────────────────────────────────────────────────

export async function sdkLanguages(ctx: Context): Promise<void> {
  const languages = await withSpinner("Loading language catalogue", () =>
    api.listLanguages(ctx.client),
  );

  emit({ languages }, () => {
    heading(`Languages ${dim(`(${languages.length})`)}`);
    table(languages, [
      { header: "id", value: (l) => bold(l.id), flex: 3 },
      { header: "name", value: (l) => l.name ?? dim("—"), flex: 3 },
      {
        header: "preferences",
        value: (l) =>
          dim(Object.keys(l.preferences ?? {}).slice(0, 6).join(", ")),
        flex: 1,
      },
    ]);
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function sdkSettingsGet(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const bundle = await withSpinner("Loading SDK settings", () =>
    api.getSdkSettings(ctx.client, projectId),
  );

  // `--key a.b.c` prints one value, which is what scripts and agents want.
  const key = flagString(ctx.args, "key");
  if (key !== undefined) {
    const value = dig(bundle as unknown as Record<string, unknown>, key);
    emit({ key, value }, () => line(JSON.stringify(value, null, 2)));
    return;
  }

  emit(bundle, () => {
    heading("SDK settings");
    keyValues([
      ["revision", String(bundle.revision)],
      [
        "released",
        bundle.release === undefined
          ? dim("never published")
          : `${bundle.release.version} ${dim(relativeTime(bundle.release.publishedAt))}`,
      ],
      ["endpoint overrides", String(Object.keys(bundle.sdkEndpoints).length)],
      ["repo hooks", String(bundle.repoHookKeys.length)],
    ]);
    line();
    line(dim("  settings:"));
    for (const [key2, value] of Object.entries(bundle.sdkSettings)) {
      line(`    ${gray(key2.padEnd(28))} ${renderValue(value)}`);
    }
  });
}

/**
 * `octri sdk settings set <key> <value>` / `--file settings.json`.
 *
 * Reads the current bundle first so the revision guard is satisfied and no
 * unrelated key is dropped — the API replaces `sdkSettings` wholesale.
 */
export async function sdkSettingsSet(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const bundle = await api.getSdkSettings(ctx.client, projectId);

  const file = flagString(ctx.args, "file");
  let settings: Record<string, unknown>;

  if (file !== undefined) {
    settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } else {
    const [key, ...valueParts] = ctx.args.positionals;
    const raw = valueParts.join(" ");
    if (key === undefined || raw === "") {
      throw new Error(
        "Usage: octri sdk settings set <key> <value>  (or --file settings.json)",
      );
    }
    settings = { ...bundle.sdkSettings };
    assign(settings, key, coerce(raw));
  }

  const version = flagString(ctx.args, "version");
  const changelog = flagString(ctx.args, "changelog");

  await withSpinner(
    `Publishing settings ${dim(`rev ${bundle.revision} → ${bundle.revision + 1}`)}`,
    () =>
      api.putSdkSettings(ctx.client, projectId, {
        settings,
        endpoints: bundle.sdkEndpoints,
        revision: bundle.revision,
        ...(version === undefined ? {} : { version }),
        ...(changelog === undefined ? {} : { changelog }),
      }),
  );

  emit({ projectId, revision: bundle.revision + 1, settings }, () =>
    success(`Settings saved at revision ${bold(String(bundle.revision + 1))}.`),
  );
}

// ─── Operations / preview / validate ──────────────────────────────────────────

export async function sdkOperations(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const operations = await withSpinner("Parsing current spec", () =>
    api.listOperations(ctx.client, projectId),
  );

  const filter = flagString(ctx.args, "grep")?.toLowerCase();
  const shown =
    filter === undefined
      ? operations
      : operations.filter((op) =>
          `${op.method} ${op.path} ${op.summary ?? ""}`
            .toLowerCase()
            .includes(filter),
        );

  emit({ projectId, total: operations.length, operations: shown }, () => {
    heading(`Operations ${dim(`(${shown.length}/${operations.length})`)}`);
    table(shown, [
      { header: "method", value: (o) => methodColor(o.method), flex: 6 },
      { header: "path", value: (o) => o.path, flex: 1, minWidth: 20 },
      {
        header: "operationId",
        value: (o) => dim(o.operationId ?? "—"),
        flex: 4,
      },
      {
        header: "",
        value: (o) => (o.deprecated === true ? yellow("deprecated") : ""),
        flex: 8,
      },
    ]);
  });
}

/**
 * `octri sdk preview --lang go [--out dir]` — a real generator run for one
 * language with no build spent. The fast half of the generator loop.
 */
export async function sdkPreview(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const language =
    flagString(ctx.args, "lang") ?? ctx.args.positionals[0];
  if (language === undefined) {
    throw new Error("Usage: octri sdk preview --lang <language>");
  }

  const files = await withSpinner(
    `Generating ${bold(language)} preview`,
    () => api.previewSdk(ctx.client, projectId, language),
    { success: (f) => `Generated ${bold(String(f.length))} files`, frames: "pulse" },
  );

  const out = flagString(ctx.args, "out");
  if (out !== undefined) {
    for (const file of files) {
      const target = join(out, file.path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, file.content);
    }
    note(`Wrote ${files.length} files to ${out}`);
  }

  const show = flagString(ctx.args, "show");
  if (show !== undefined) {
    const hit = files.find((f) => f.path === show || f.path.endsWith(show));
    if (hit === undefined) {
      throw new Error(`No previewed file matches "${show}".`);
    }
    emit({ path: hit.path, content: hit.content }, () => {
      rule(hit.path);
      line(hit.content);
    });
    return;
  }

  emit(
    { projectId, language, files: files.map((f) => ({ path: f.path, bytes: f.content.length })) },
    () => {
      heading(`${language} ${dim(`— ${files.length} files`)}`);
      tree(
        treeFromPaths(
          files.map((f) => ({ path: f.path, detail: bytes(f.content.length) })),
        ),
      );
      note("--show <path> prints a file, --out <dir> writes them all.");
    },
  );
}

export async function sdkValidate(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const result = await withSpinner(
    "Validating spec against the generator",
    () => api.validateSpec(ctx.client, projectId),
    { frames: "arc" },
  );

  emit(result, () => {
    const errors = result.errors ?? [];
    const warnings = result.warnings ?? [];

    if (result.valid && errors.length === 0) {
      success("Spec is valid.");
    } else {
      line(`${red(symbols.fail)} ${bold(`${errors.length} validation errors`)}`);
    }

    if (result.summary !== undefined) {
      keyValues(
        Object.entries(result.summary).map(
          ([k, v]) => [k, renderValue(v)] as const,
        ),
      );
    }
    for (const error of errors.slice(0, 25)) {
      line(`  ${red(symbols.bullet)} ${error.message} ${dim(error.path ?? "")}`);
    }
    if (errors.length > 25) note(`…and ${errors.length - 25} more.`);
    for (const w of warnings.slice(0, 10)) {
      line(`  ${yellow(symbols.warn)} ${w.message} ${dim(w.path ?? "")}`);
    }
  });
}

export async function sdkAudit(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const result = await withSpinner("Auditing SDK surface", () =>
    api.auditSdk(ctx.client, projectId),
  );

  emit(result, () => {
    heading("SDK audit");
    const findings = (result["findings"] ?? result["issues"]) as
      | { severity?: string; message?: string; path?: string }[]
      | undefined;

    if (findings === undefined || findings.length === 0) {
      keyValues(
        Object.entries(result).map(([k, v]) => [k, renderValue(v)] as const),
      );
      return;
    }
    table(findings, [
      {
        header: "severity",
        value: (f) => statusLabel(f.severity ?? "info"),
        flex: 5,
      },
      { header: "finding", value: (f) => f.message ?? "", flex: 1, minWidth: 24 },
      { header: "where", value: (f) => dim(f.path ?? ""), flex: 3 },
    ]);
  });
}

// ─── Builds ───────────────────────────────────────────────────────────────────

/**
 * `octri sdk build --lang go,rust [--watch] [--download]`
 *
 * `--watch` is the default in a TTY: a queued build with no feedback is the
 * least useful thing this command could do.
 */
export async function sdkBuild(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();

  const languages =
    flagList(ctx.args, "lang").length > 0
      ? flagList(ctx.args, "lang")
      : ctx.settings.defaultLanguages;

  if (languages.length === 0) {
    throw new Error(
      "Pick languages: --lang go,rust  (or set a default with `octri config set defaultLanguages go,rust`).",
    );
  }

  const version = flagString(ctx.args, "version");
  const releaseRevision = flagNumber(ctx.args, "revision");

  const trigger = await withSpinner(
    `Queuing build ${dim(languages.join(", "))}`,
    () =>
      api.triggerBuild(ctx.client, projectId, {
        languages,
        ...(version === undefined ? {} : { version }),
        ...(releaseRevision === undefined ? {} : { releaseRevision }),
      }),
    { success: (r) => `Build ${bold(r.buildId)} queued` },
  );

  const shouldWatch =
    ctx.args.flags["watch"] !== false && !flagBool(ctx.args, "detach");

  if (!shouldWatch) {
    emit({ buildId: trigger.buildId, languages }, () =>
      note(`Follow it with \`octri sdk watch ${trigger.buildId}\`.`),
    );
    return;
  }

  const build = await followBuild(ctx, projectId, trigger.buildId, languages);

  if (flagBool(ctx.args, "download") && build.status !== "failed") {
    await downloadArtifacts(ctx, projectId, build.id, flagList(ctx.args, "lang"));
  }

  emit(build, () => undefined);
  if (build.status === "failed") process.exitCode = 1;
}

export async function sdkBuilds(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const page = flagNumber(ctx.args, "page") ?? 1;
  const result = await withSpinner("Loading builds", () =>
    api.listBuilds(ctx.client, projectId, page),
  );

  emit(result, () => {
    heading(`Builds ${dim(`(${result.total})`)}`);
    table(
      result.builds,
      [
        { header: "id", value: (b) => dim(b.id), flex: 8, minWidth: 24 },
        { header: "version", value: (b) => bold(b.version), flex: 4 },
        { header: "status", value: (b) => statusLabel(b.status), flex: 5 },
        {
          header: "languages",
          value: (b) => b.artifacts.map(langChip).join(" "),
          flex: 1,
          minWidth: 20,
        },
        { header: "trigger", value: (b) => dim(b.trigger), flex: 6 },
        { header: "when", value: (b) => relativeTime(b.createdAt), flex: 5 },
      ],
      { emptyMessage: "No builds yet — `octri sdk build --lang go`." },
    );
  });
}

/** `octri sdk watch <buildId>` — attach the live lane view to a running build. */
export async function sdkWatch(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const buildId = ctx.args.positionals[0];
  if (buildId === undefined) throw new Error("Usage: octri sdk watch <buildId>");

  const existing = await api.findBuild(ctx.client, projectId, buildId);
  if (existing === undefined) throw new Error(`Build ${buildId} not found.`);

  const build = await followBuild(
    ctx,
    projectId,
    buildId,
    existing.languages,
  );
  emit(build, () => undefined);
  if (build.status === "failed") process.exitCode = 1;
}

export async function sdkArtifacts(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const buildId = ctx.args.positionals[0] ?? (await latestBuildId(ctx, projectId));
  const artifacts = await withSpinner("Loading artifacts", () =>
    api.listArtifacts(ctx.client, projectId, buildId),
  );

  emit({ buildId, artifacts }, () => {
    heading(`Artifacts ${dim(buildId)}`);
    table(
      artifacts,
      [
        { header: "language", value: (a) => bold(a.language), flex: 4 },
        { header: "version", value: (a) => a.version, flex: 5 },
        { header: "size", value: (a) => bytes(a.fileSizeBytes), align: "right", flex: 6 },
        {
          header: "publish",
          value: (a) => (a.publishStatus === undefined ? dim("—") : statusLabel(a.publishStatus)),
          flex: 5,
        },
        {
          header: "package",
          value: (a) => dim(a.registryPackageName ?? ""),
          flex: 1,
        },
      ],
      { emptyMessage: "No artifacts on this build." },
    );
  });
}

/**
 * `octri sdk download [buildId] --lang go --out dir [--extract]`
 *
 * Extraction is on by default: the point of pulling an artifact locally is to
 * read the generated source.
 */
export async function sdkDownload(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const buildId = ctx.args.positionals[0] ?? (await latestBuildId(ctx, projectId));
  await downloadArtifacts(ctx, projectId, buildId, flagList(ctx.args, "lang"));
}

export async function sdkRetry(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const buildId = ctx.args.positionals[0] ?? (await latestBuildId(ctx, projectId));

  let languages = flagList(ctx.args, "lang");
  if (languages.length === 0) {
    // Default to exactly the languages that failed — the usual intent.
    const build = await api.findBuild(ctx.client, projectId, buildId);
    languages =
      build?.artifacts.filter((a) => a.status === "failed").map((a) => a.languageId) ??
      [];
    if (languages.length === 0) {
      throw new Error("Nothing failed on that build. Pass --lang to force a retry.");
    }
  }

  await withSpinner(`Retrying ${dim(languages.join(", "))}`, () =>
    api.retryBuild(ctx.client, projectId, buildId, languages),
  );

  if (ctx.args.flags["watch"] !== false) {
    const build = await followBuild(ctx, projectId, buildId, languages);
    emit(build, () => undefined);
    if (build.status === "failed") process.exitCode = 1;
    return;
  }
  emit({ buildId, languages }, () => success("Retry queued."));
}

export async function sdkPublish(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const buildId = ctx.args.positionals[0] ?? (await latestBuildId(ctx, projectId));
  const languages = flagList(ctx.args, "lang");
  const mode = flagString(ctx.args, "mode") === "pack" ? "pack" : "release";

  if (mode === "release" && !flagBool(ctx.args, "yes")) {
    warn(
      "`--mode release` publishes to public package registries. Re-run with --yes to confirm, or use --mode pack for a dry run.",
    );
    return;
  }

  const result = await withSpinner(
    `Publishing ${dim(buildId)} ${dim(`(${mode})`)}`,
    () =>
      api.publishBuild(ctx.client, projectId, buildId, {
        mode,
        ...(languages.length > 0 ? { languages } : {}),
        ...(flagBool(ctx.args, "skip-validate") ? { skipValidate: true } : {}),
      }),
  );

  emit(result, () => success(`Publish ${mode} queued.`));
}

// ─── Repos ────────────────────────────────────────────────────────────────────

export async function sdkRepos(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const repos = await withSpinner("Loading SDK repos", () =>
    api.listRepos(ctx.client, projectId),
  );

  emit({ projectId, repos }, () => {
    heading("SDK repositories");
    table(
      repos,
      [
        { header: "lang", value: (r) => bold(r.langId), flex: 5 },
        {
          header: "repo",
          value: (r) =>
            r.owner === undefined ? dim("—") : `${r.owner}/${r.repo ?? ""}`,
          flex: 1,
          minWidth: 18,
        },
        { header: "branch", value: (r) => dim(r.branch ?? "—"), flex: 5 },
        {
          header: "status",
          value: (r) => statusLabel(r.status ?? "unlinked"),
          flex: 5,
        },
        { header: "synced", value: (r) => relativeTime(r.lastSyncedAt), flex: 5 },
      ],
      { emptyMessage: "No per-language repositories linked." },
    );
  });
}

// ─── Shared internals ─────────────────────────────────────────────────────────

/** Live per-language lane view, polled until every language settles. */
async function followBuild(
  ctx: Context,
  projectId: string,
  buildId: string,
  languages: readonly string[],
): Promise<api.Build> {
  const startedAt = Date.now();
  const lanes = new TaskList(
    languages.map((lang) => ({
      id: lang,
      label: lang.padEnd(8),
      state: "pending" as TaskState,
      detail: "queued",
    })),
    `  ${accent(symbols.dot)} build ${dim(buildId)}`,
  ).start();

  let latest: api.Build | undefined;

  const build = await api.watchBuild(ctx.client, projectId, buildId, {
    intervalMs: flagNumber(ctx.args, "interval") ?? 2_000,
    onTick: (current) => {
      latest = current;
      for (const artifact of current.artifacts) {
        lanes.add({
          id: artifact.languageId,
          label: artifact.languageId.padEnd(8),
          state: "pending",
        });
        lanes.set(artifact.languageId, {
          state: laneState(artifact.status),
          detail: laneDetail(artifact, startedAt),
        });
      }
    },
  });

  lanes.stop();

  const failed = build.artifacts.filter((a) => a.status === "failed");
  const ready = build.artifacts.filter(
    (a) => a.status === "ready" || a.status === "verified",
  );

  line();
  if (failed.length === 0) {
    success(
      `${bold(String(ready.length))} languages built ${dim(`in ${duration(Date.now() - startedAt)}`)}`,
    );
  } else {
    line(
      `${red(symbols.fail)} ${bold(String(failed.length))} failed, ${green(String(ready.length))} ready ${dim(`in ${duration(Date.now() - startedAt)}`)}`,
    );
    for (const artifact of failed) {
      panel(
        (artifact.errorMessage ?? "No error message returned.").split("\n").slice(0, 12),
        { title: `${red(artifact.languageId)} failed` },
      );
    }
    note(`Retry just those: octri sdk retry ${buildId} --lang ${failed.map((f) => f.languageId).join(",")}`);
  }

  return latest ?? build;
}

/** Downloads (and by default extracts) a build's artifacts into a local dir. */
async function downloadArtifacts(
  ctx: Context,
  projectId: string,
  buildId: string,
  onlyLanguages: readonly string[],
): Promise<void> {
  const artifacts = await api.listArtifacts(ctx.client, projectId, buildId);
  const wanted =
    onlyLanguages.length === 0
      ? artifacts
      : artifacts.filter((a) => onlyLanguages.includes(a.language));

  if (wanted.length === 0) {
    warn("No matching artifacts to download.");
    return;
  }

  const root =
    flagString(ctx.args, "out") ?? join(cacheDir(), "builds", buildId);
  mkdirSync(root, { recursive: true });
  const shouldExtract = ctx.args.flags["extract"] !== false;
  const written: { language: string; path: string; files: number }[] = [];

  for (const artifact of wanted) {
    if (artifact.url === undefined) {
      warn(`${artifact.language}: no download URL (build may still be running).`);
      continue;
    }

    const spinner = new Spinner(
      `Downloading ${bold(artifact.language)} ${dim(bytes(artifact.fileSizeBytes))}`,
    ).start();

    const response = await ctx.client.fetchRaw(artifact.url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const filename = `${artifact.language}-${artifact.version}${guessExtension(artifact.url)}`;
    const archivePath = join(root, filename);
    writeFileSync(archivePath, buffer);

    if (!shouldExtract) {
      spinner.succeed(`${artifact.language} ${dim(archivePath)}`);
      written.push({ language: artifact.language, path: archivePath, files: 0 });
      continue;
    }

    const destination = join(root, artifact.language);
    try {
      const files = extract(buffer, destination, filename);
      spinner.succeed(
        `${bold(artifact.language)} ${dim(`${files.length} files → ${destination}`)}`,
      );
      written.push({
        language: artifact.language,
        path: destination,
        files: files.length,
      });
    } catch (err) {
      spinner.warnWith(
        `${artifact.language}: saved archive, could not extract (${(err as Error).message})`,
      );
      written.push({ language: artifact.language, path: archivePath, files: 0 });
    }
  }

  emit({ buildId, root, artifacts: written }, () => {
    line();
    note(`Artifacts under ${root}`);
  });
}

async function latestBuildId(
  ctx: Context,
  projectId: string,
): Promise<string> {
  const result = await api.listBuilds(ctx.client, projectId, 1);
  const latest = result.builds[0];
  if (latest === undefined) throw new Error("This project has no builds yet.");
  return latest.id;
}

function laneState(status: api.LangBuildStatus): TaskState {
  if (status === "failed") return "failed";
  if (status === "ready" || status === "verified") return "done";
  if (status === "queued") return "pending";
  return "running";
}

function laneDetail(
  artifact: api.BuildArtifactSummary,
  startedAt: number,
): string {
  if (artifact.status === "failed") {
    const first = (artifact.errorMessage ?? "failed").split("\n")[0] ?? "failed";
    return first.slice(0, 72);
  }
  if (artifact.status === "ready" || artifact.status === "verified") {
    return `${artifact.status} · ${duration(Date.now() - startedAt)}`;
  }
  return `${artifact.status}…`;
}

function langChip(artifact: api.BuildArtifactSummary): string {
  const paint =
    artifact.status === "failed"
      ? red
      : artifact.status === "ready" || artifact.status === "verified"
        ? green
        : cyan;
  return paint(artifact.languageId);
}

function methodColor(method: string): string {
  const upper = method.toUpperCase();
  switch (upper) {
    case "GET":
      return green(upper);
    case "POST":
      return cyan(upper);
    case "PUT":
    case "PATCH":
      return yellow(upper);
    case "DELETE":
      return red(upper);
    default:
      return dim(upper);
  }
}

/** Compact one-line rendering for arbitrary settings values. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return dim("—");
  if (typeof value === "boolean") return value ? green("true") : dim("false");
  if (typeof value === "object") {
    const json = JSON.stringify(value);
    return dim(json.length > 72 ? `${json.slice(0, 71)}…` : json);
  }
  return String(value);
}

/** Reads `a.b.c` out of a nested object. */
function dig(source: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc === undefined || acc === null
          ? undefined
          : (acc as Record<string, unknown>)[key],
      source,
    );
}

/** Writes `a.b.c`, creating intermediate objects. */
function assign(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop() as string;
  let cursor = target;
  for (const key of keys) {
    if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[last] = value;
}

/** `true`/`false`/numbers/JSON come through the shell as strings. */
function coerce(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function guessExtension(url: string): string {
  const path = url.split("?")[0] ?? "";
  if (path.endsWith(".tgz") || path.endsWith(".tar.gz")) return ".tgz";
  if (path.endsWith(".zip")) return ".zip";
  return ".tgz";
}

/** Build-duration sparkline for `octri sdk stats`. */
export async function sdkStats(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const result = await withSpinner("Loading build history", () =>
    api.listBuilds(ctx.client, projectId, 1),
  );

  const byStatus = new Map<string, number>();
  for (const build of result.builds) {
    byStatus.set(build.status, (byStatus.get(build.status) ?? 0) + 1);
  }
  const langFailures = new Map<string, number>();
  for (const build of result.builds) {
    for (const artifact of build.artifacts) {
      if (artifact.status === "failed") {
        langFailures.set(
          artifact.languageId,
          (langFailures.get(artifact.languageId) ?? 0) + 1,
        );
      }
    }
  }

  const trend = result.builds
    .slice()
    .reverse()
    .map((b) => (b.status === "failed" ? 0 : b.status === "partial" ? 1 : 2));

  emit(
    {
      total: result.total,
      byStatus: Object.fromEntries(byStatus),
      failuresByLanguage: Object.fromEntries(langFailures),
    },
    () => {
      heading("Build health");
      keyValues([
        ["builds", String(result.total)],
        ...[...byStatus].map(([k, v]) => [k, String(v)] as const),
      ]);
      if (!isStatic()) {
        line();
        line(`  ${dim("trend")}  ${sparkline(trend)} ${dim("(oldest → newest)")}`);
      }
      if (langFailures.size > 0) {
        line();
        line(dim("  failures by language"));
        for (const [lang, count] of [...langFailures].sort((a, b) => b[1] - a[1])) {
          line(`    ${red(symbols.bullet)} ${lang.padEnd(8)} ${count}`);
        }
      }
    },
  );
}
