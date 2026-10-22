/**
 * `octri docs endpoints …`: endpoints added, or marked for removal, ahead of
 * the next publish, the same drafts the API Studio's "Add endpoint" makes.
 *
 * Nothing here touches the spec until `publish`, which writes every draft into
 * it as a new version. Like every studio edit, nothing reaches readers, SDKs
 * or MCP before then.
 */

import * as api from "../api.js";
import { flagString } from "../args.js";
import { bold, dim, green, red } from "../ui/ansi.js";
import { emit, heading, keyValues, note, relativeTime, success } from "../ui/output.js";
import { withSpinner } from "../ui/spinner.js";
import { table } from "../ui/table.js";

import type { Context } from "../context.js";

const PUBLISH_HINT = "octri docs endpoints publish: write the drafts into the spec";

export async function endpointsList(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const drafts = await withSpinner("Loading draft endpoints", () =>
    api.listDraftEndpoints(ctx.client, projectId),
  );

  emit({ projectId, drafts }, () => {
    heading(`Draft endpoints ${dim(`(${drafts.length})`)}`);
    table(
      drafts,
      [
        {
          header: "change",
          value: (d) => (d.action === "add" ? green("add") : red("remove")),
          flex: 6,
        },
        {
          header: "endpoint",
          value: (d) => bold(`${d.method.toUpperCase()} ${d.path}`),
          flex: 1,
          minWidth: 18,
        },
        { header: "summary", value: (d) => d.summary, flex: 1, minWidth: 14 },
        { header: "updated", value: (d) => relativeTime(d.updatedAt), flex: 5 },
        { header: "id", value: (d) => dim(d.id), flex: 4, minWidth: 24 },
      ],
      { emptyMessage: "No draft endpoints." },
    );
    if (drafts.length > 0) note(PUBLISH_HINT);
  });
}

/** `GET` and `get` both name the method; the path is passed through as typed. */
function methodAndPath(ctx: Context, usage: string): { method: string; path: string } {
  const [method, path] = ctx.args.positionals;
  if (method === undefined || path === undefined) throw new Error(usage);
  return { method: method.toUpperCase(), path };
}

/** `octri docs endpoints add <METHOD> <path> --summary "…" [--description "…"]` */
export async function endpointsAdd(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const usage =
    'Usage: octri docs endpoints add <METHOD> <path> --summary "List users" [--description "…"]';
  const { method, path } = methodAndPath(ctx, usage);
  const summary = flagString(ctx.args, "summary");
  if (summary === undefined) throw new Error(usage);
  const description = flagString(ctx.args, "description");

  const draft = await withSpinner(`Drafting ${bold(`${method} ${path}`)}`, () =>
    api.createDraftEndpoint(ctx.client, projectId, {
      method,
      path,
      summary,
      ...(description === undefined ? {} : { description }),
    }),
  );
  emit(draft, () => {
    success(`Drafted ${bold(`${method} ${path}`)} ${dim(draft.id)}`);
    note(PUBLISH_HINT);
  });
}

/** `octri docs endpoints remove <METHOD> <path>`: an endpoint the spec has. */
export async function endpointsRemove(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const { method, path } = methodAndPath(
    ctx,
    "Usage: octri docs endpoints remove <METHOD> <path>",
  );

  const draft = await withSpinner(`Marking ${bold(`${method} ${path}`)} for removal`, () =>
    api.markEndpointDeletion(ctx.client, projectId, { method, path }),
  );
  emit(draft, () => {
    success(`${bold(`${method} ${path}`)} will be removed on the next publish.`);
    note(PUBLISH_HINT);
  });
}

/** `octri docs endpoints edit <draftId> [--summary "…"] [--description "…"]` */
export async function endpointsEdit(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const draftId = ctx.args.positionals[0];
  const summary = flagString(ctx.args, "summary");
  const description = flagString(ctx.args, "description");
  if (draftId === undefined || (summary === undefined && description === undefined)) {
    throw new Error(
      'Usage: octri docs endpoints edit <draftId> [--summary "…"] [--description "…"]',
    );
  }

  const draft = await withSpinner("Updating draft", () =>
    api.updateDraftEndpoint(ctx.client, projectId, draftId, {
      ...(summary === undefined ? {} : { summary }),
      ...(description === undefined ? {} : { description }),
    }),
  );
  emit(draft, () => success(`Draft ${dim(draft.id)} updated.`));
}

/** `octri docs endpoints discard <draftId>`: drop a draft without publishing it. */
export async function endpointsDiscard(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const draftId = ctx.args.positionals[0];
  if (draftId === undefined) {
    throw new Error("Usage: octri docs endpoints discard <draftId>");
  }
  await withSpinner("Discarding draft", () =>
    api.discardDraftEndpoint(ctx.client, projectId, draftId),
  );
  emit({ discarded: true, id: draftId }, () => success("Draft discarded."));
}

/**
 * `octri docs endpoints publish [--commit-to-github|--no-commit-to-github]`
 *
 * Without the flag the project's docs setting decides whether the new spec is
 * committed back to the connected repo.
 */
export async function endpointsPublish(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const commit = ctx.args.flags["commit-to-github"];

  const result = await withSpinner("Writing drafts into the spec", () =>
    api.publishDraftEndpoints(
      ctx.client,
      projectId,
      typeof commit === "boolean" ? commit : undefined,
    ),
  );
  emit(result, () => {
    const published = result.published;
    if (published === null) {
      success("Nothing to publish: the spec already matches the drafts.");
      return;
    }
    success("Drafts published as a new spec version.");
    keyValues([
      ["spec", published.specId],
      ["added", String(published.added)],
      ["removed", String(published.removed)],
      ["endpoints", String(published.endpointCount)],
    ]);
    note(`octri specs status ${published.specId}: follow the pipeline`);
  });
}
