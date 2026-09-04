/**
 * `octri specs …` — the spec side of the loop: push a spec in, watch it parse,
 * inspect what the parser made of it.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

import * as api from "../api.js";
import { flagBool, flagString } from "../args.js";
import { bold, dim, green } from "../ui/ansi.js";
import {
  bytes,
  emit,
  heading,
  keyValues,
  line,
  note,
  relativeTime,
  statusLabel,
  success,
  warn,
} from "../ui/output.js";
import { Spinner, withSpinner } from "../ui/spinner.js";
import { table } from "../ui/table.js";

import type { Context } from "../context.js";

export async function specsList(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const specs = await withSpinner("Loading specs", () =>
    api.listSpecs(ctx.client, projectId),
  );

  emit({ projectId, specs }, () => {
    heading(`Specs ${dim(`(${specs.length})`)}`);
    table(
      specs,
      [
        {
          header: "",
          value: (s) => (s.isCurrent === true ? green("●") : dim("○")),
          minWidth: 1,
          flex: 9,
        },
        { header: "version", value: (s) => bold(s.version), flex: 3 },
        { header: "id", value: (s) => dim(s.id), flex: 8, minWidth: 24 },
        {
          header: "status",
          value: (s) => statusLabel(s.status ?? "unknown"),
          flex: 4,
        },
        {
          header: "endpoints",
          value: (s) => String(s.endpointCount ?? ""),
          align: "right",
          flex: 5,
        },
        { header: "created", value: (s) => relativeTime(s.createdAt), flex: 5 },
      ],
      { emptyMessage: "No specs — `octri specs push <file>`." },
    );
  });
}

/**
 * `octri specs push <file|->` — uploads spec text and, unless `--no-wait`,
 * follows the ingestion job to completion.
 */
export async function specsPush(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const source = ctx.args.positionals[0];
  if (source === undefined) {
    throw new Error("Usage: octri specs push <file.yaml|->  (or --url <url>)");
  }

  const content =
    source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");

  const label = source === "-" ? "stdin" : basename(source);
  const result = await withSpinner(
    `Uploading ${bold(label)} ${dim(bytes(Buffer.byteLength(content)))}`,
    () => api.uploadSpecContent(ctx.client, projectId, content),
    { success: (r) => `Spec ${bold(r.version)} ingested` },
  );

  if (ctx.args.flags.wait !== false) {
    await followIngestion(ctx, projectId, result.specId);
  }

  emit({ projectId, ...result }, () => {
    keyValues([
      ["spec", result.specId],
      ["version", result.version],
    ]);
  });
}

/** `octri specs import <url>` — pull a spec straight from a public URL. */
export async function specsImport(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const url = ctx.args.positionals[0] ?? flagString(ctx.args, "url");
  if (url === undefined) throw new Error("Usage: octri specs import <url>");

  const result = await withSpinner(
    `Fetching ${dim(url)}`,
    () => api.importSpecUrl(ctx.client, projectId, url),
    { success: (r) => `Spec ${bold(r.version)} ingested` },
  );

  if (ctx.args.flags.wait !== false) {
    await followIngestion(ctx, projectId, result.specId);
  }
  emit({ projectId, ...result }, () => undefined);
}

export async function specsStatus(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const specId = ctx.args.positionals[0];
  if (specId === undefined)
    throw new Error("Usage: octri specs status <specId>");

  const status = await api.specStatus(ctx.client, projectId, specId);
  emit(status, () => {
    heading(`Spec ${bold(status.spec.version)}`);
    keyValues([
      ["spec", status.spec.id],
      ["status", status.spec.status],
      ["endpoints", String(status.spec.endpointCount ?? 0)],
      ["current", status.spec.isCurrent === true ? "yes" : "no"],
      ["generation", status.generation.overallStatus],
      ["docs", status.project.docsUrl ?? "—"],
    ]);
    line();
    heading("Pipeline");
    for (const job of status.generation.jobs) {
      const { total, completed, failed } = job.progress;
      const counts = total > 0 ? ` ${completed}/${total}` : "";
      line(
        `  ${jobLabel(job.type)} ${dim(job.status + counts)}` +
          (failed > 0 ? ` ${dim(`${failed} failed`)}` : ""),
      );
    }
  });
}

export async function specsDelete(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const specId = ctx.args.positionals[0];
  if (specId === undefined)
    throw new Error("Usage: octri specs delete <specId>");

  if (!flagBool(ctx.args, "yes")) {
    warn("Deleting a spec is irreversible. Re-run with --yes to confirm.");
    return;
  }

  await withSpinner(`Deleting ${dim(specId)}`, () =>
    api.deleteSpec(ctx.client, projectId, specId),
  );
  emit({ deleted: specId }, () => success("Spec deleted."));
}

// ─── Ingestion follower ───────────────────────────────────────────────────────

/**
 * Polls the spec's status until ingestion AND the generation pipeline behind it
 * have settled. Parsing a large enterprise spec takes tens of seconds, and
 * knowing it finished is the whole point of pushing one.
 *
 * The terminal signal is `generation.overallStatus`, not the spec row's own
 * `status`: the spec flips to `complete` as soon as it parses, while the doc
 * pages, embeddings and changelog are still being written behind it.
 */
async function followIngestion(
  ctx: Context,
  projectId: string,
  specId: string,
): Promise<void> {
  const spinner = new Spinner("Parsing spec", "pulse").start();
  const deadline = Date.now() + 5 * 60_000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    let status: api.SpecStatus;
    try {
      status = await api.specStatus(ctx.client, projectId, specId);
    } catch {
      // A transient read failure mid-ingest is not a reason to abort the wait.
      continue;
    }

    const { overallStatus, percentComplete, anyFailed } = status.generation;
    const running = status.generation.jobs.find((j) => j.status === "processing");
    spinner.update(
      `${running === undefined ? "Parsing spec" : jobLabel(running.type)} ${dim(overallStatus)}` +
        (percentComplete > 0 ? dim(` ${percentComplete}%`) : ""),
    );

    if (overallStatus === "failed") {
      const failed = status.generation.jobs
        .filter((j) => j.progress.failed > 0)
        .map((j) => `${j.type} (${j.progress.failed})`);
      spinner.failWith(
        `Spec ingestion failed${failed.length > 0 ? `: ${failed.join(", ")}` : ""}`,
      );
      return;
    }
    if (overallStatus === "complete" || overallStatus === "partial") {
      const seconds = Math.round(spinner.elapsed() / 1000);
      if (overallStatus === "partial" || anyFailed) {
        spinner.warnWith(`Spec ready with failures ${dim(`in ${seconds}s`)}`);
        note("octri specs status <specId> — which job failed");
      } else {
        spinner.succeed(`Spec ready ${dim(`in ${seconds}s`)}`);
      }
      return;
    }
  }

  spinner.warnWith("Still processing — check `octri specs status <specId>` later.");
  line();
}

/** Job type ids read like slugs; give the spinner something human. */
function jobLabel(type: string): string {
  switch (type) {
    case "ai-generate":
      return "Writing docs";
    case "embed":
      return "Indexing for search";
    case "changelog":
      return "Building changelog";
    case "rebuild":
      return "Rebuilding site";
    default:
      return type;
  }
}
