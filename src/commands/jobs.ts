/**
 * `octri jobs` — the background generation queue behind a project.
 *
 * Worth its own command because the spec-status view only covers one spec's
 * pipeline: a single-endpoint rebuild triggered from the studio is a job with
 * no spec attached, and it shows up here and nowhere else.
 */

import * as api from "../api.js";
import { bold, dim, green, red, yellow } from "../ui/ansi.js";
import {
  emit,
  heading,
  keyValues,
  line,
  note,
  success,
} from "../ui/output.js";
import { withSpinner } from "../ui/spinner.js";

import type { Context } from "../context.js";

export async function jobsList(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const summary = await withSpinner("Loading jobs", () =>
    api.jobSummary(ctx.client, projectId),
  );

  emit(summary, () => {
    heading(`Generation jobs ${dim(`(${summary.total})`)}`);
    keyValues([
      ["queued", summary.queued > 0 ? yellow(String(summary.queued)) : dim("0")],
      [
        "processing",
        summary.processing > 0 ? bold(String(summary.processing)) : dim("0"),
      ],
      ["complete", green(String(summary.complete))],
      ["failed", summary.failed > 0 ? red(String(summary.failed)) : dim("0")],
    ]);

    if (summary.total === 0) {
      line();
      note("Nothing has been generated for this project yet.");
      return;
    }
    if (summary.queued + summary.processing === 0 && summary.failed === 0) {
      line();
      success("Queue is drained.");
    }
  });
}

export async function jobsShow(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const jobId = ctx.args.positionals[0];
  if (jobId === undefined) throw new Error("Usage: octri jobs show <jobId>");

  const job = await withSpinner("Loading job", () =>
    api.getJob(ctx.client, projectId, jobId),
  );

  emit(job, () => {
    heading(`Job ${dim(jobId)}`);
    keyValues(
      Object.entries(job)
        .filter(([, v]) => typeof v !== "object" || v === null)
        .map(([k, v]) => [k, String(v)] as const),
    );
    const progress = job["progress"];
    if (typeof progress === "object" && progress !== null) {
      line();
      heading("Progress");
      keyValues(
        Object.entries(progress as Record<string, unknown>).map(
          ([k, v]) => [k, String(v)] as const,
        ),
      );
    }
  });
}
