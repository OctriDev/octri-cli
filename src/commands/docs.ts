/**
 * `octri docs …` and `octri mcp tools` — the documentation and agent-facing
 * surfaces a project publishes.
 */

import { flagString } from "../args.js";
import * as api from "../api.js";
import type { Context } from "../context.js";
import { bold, dim } from "../ui/ansi.js";
import { rule } from "../ui/box.js";
import {
  emit,
  heading,
  line,
  relativeTime,
  note,
} from "../ui/output.js";
import { withSpinner } from "../ui/spinner.js";
import { table } from "../ui/table.js";

export async function docsPages(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const pages = await withSpinner("Loading doc pages", () =>
    api.listDocPages(ctx.client, projectId),
  );

  emit({ projectId, pages }, () => {
    heading(`Doc pages ${dim(`(${pages.length})`)}`);
    table(
      pages,
      [
        { header: "slug", value: (p) => bold(p.slug), flex: 2, minWidth: 16 },
        { header: "title", value: (p) => p.title, flex: 1, minWidth: 16 },
        { header: "type", value: (p) => dim(p.type ?? "—"), flex: 5 },
        { header: "updated", value: (p) => relativeTime(p.updatedAt), flex: 5 },
      ],
      { emptyMessage: "No generated pages — push a spec first." },
    );
  });
}

export async function docsShow(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const slug = ctx.args.positionals[0] ?? flagString(ctx.args, "slug");
  if (slug === undefined) throw new Error("Usage: octri docs show <slug>");

  const page = await withSpinner(`Loading ${dim(slug)}`, () =>
    api.getDocPage(ctx.client, projectId, slug),
  );

  emit(page, () => {
    const content =
      (page["content"] as string | undefined) ??
      (page["markdown"] as string | undefined);
    rule(String(page["title"] ?? slug));
    if (content === undefined) {
      line(dim(JSON.stringify(page, null, 2)));
      return;
    }
    line(content);
  });
}

export async function docsChangelog(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const result = await withSpinner("Loading changelog", () =>
    api.listChangelog(ctx.client, projectId),
  );

  emit(result, () => {
    heading("Changelog");
    const entries = (result["entries"] ?? result["changelog"]) as
      | { version?: string; title?: string; createdAt?: string; summary?: string }[]
      | undefined;

    if (entries === undefined || entries.length === 0) {
      note("No changelog entries.");
      return;
    }
    for (const entry of entries) {
      line(
        `  ${bold(entry.version ?? entry.title ?? "—")} ${dim(relativeTime(entry.createdAt))}`,
      );
      if (entry.summary !== undefined) line(dim(`    ${entry.summary}`));
    }
  });
}

/** `octri mcp tools` — the tool catalogue the project's MCP server exposes. */
export async function mcpTools(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const tools = await withSpinner("Loading MCP tools", () =>
    api.listMcpTools(ctx.client, projectId),
  );

  emit({ projectId, tools }, () => {
    heading(`MCP tools ${dim(`(${tools.length})`)}`);
    table(
      tools,
      [
        { header: "tool", value: (t) => bold(t.name), flex: 2, minWidth: 18 },
        {
          header: "description",
          value: (t) => dim(t.description ?? ""),
          flex: 1,
          minWidth: 20,
        },
      ],
      { emptyMessage: "This project exposes no MCP tools yet." },
    );
  });
}
