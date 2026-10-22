/**
 * `octri docs …` and `octri mcp tools`: the documentation and agent-facing
 * surfaces a project publishes.
 */

import { flagBool, flagString } from "../args.js";
import * as api from "../api.js";
import type { Context } from "../context.js";
import { bold, dim, green, red, yellow } from "../ui/ansi.js";
import { rule } from "../ui/box.js";
import {
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
      { emptyMessage: "No generated pages. Push a spec first." },
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

/** `octri mcp tools`: the tool catalogue the project's MCP server exposes. */
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

// ─── Page authoring ───────────────────────────────────────────────────────────

/**
 * `octri docs pages generate [--all] [--clear-overrides]`
 *
 * `--all` drops every fingerprint so the whole site is rewritten. Without it
 * only pages that were never written, or whose spec moved on, are rebuilt.
 * `--clear-overrides` additionally throws away manual edits. Without it a
 * rebuild of an edited page changes what is stored and nothing of what the
 * reader sees, which is exactly what "it did nothing" looks like.
 */
export async function docsGenerate(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const mode = flagBool(ctx.args, "all") ? "all" : "missing";
  const clearOverrides = flagBool(ctx.args, "clear-overrides");

  if (clearOverrides && !flagBool(ctx.args, "yes")) {
    warn("--clear-overrides discards manual edits. Re-run with --yes to confirm.");
    return;
  }

  const result = await withSpinner(
    `Generating pages ${dim(mode === "all" ? "(all)" : "(missing + stale)")}`,
    () => api.generateDocPages(ctx.client, projectId, mode, clearOverrides),
  );
  emit(result, () => {
    success(
      `Queued ${String(result["queued"] ?? result["total"] ?? "")} page(s) for generation.`.replace(
        "  ",
        " ",
      ),
    );
    note("octri specs status <specId>: follow the pipeline");
  });
}

export async function docsRegenerate(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const pageId = ctx.args.positionals[0];
  if (pageId === undefined) {
    throw new Error("Usage: octri docs pages regenerate <docPageId>");
  }
  const result = await withSpinner("Regenerating page", () =>
    api.regenerateDocPage(ctx.client, projectId, pageId),
  );
  emit(result, () => success("Page queued for regeneration."));
}

export async function docsPublishDraft(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const pageId = ctx.args.positionals[0];
  if (pageId === undefined) {
    throw new Error("Usage: octri docs pages publish <docPageId>");
  }
  const result = await withSpinner("Publishing draft", () =>
    api.publishDocPageDraft(ctx.client, projectId, pageId),
  );
  emit(result, () => success("Draft published."));
}

export async function docsSetTitle(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const [pageId, ...rest] = ctx.args.positionals;
  const title = rest.join(" ");
  if (pageId === undefined || title === "") {
    throw new Error("Usage: octri docs pages title <docPageId> <new title>");
  }
  const result = await withSpinner("Renaming page", () =>
    api.setDocPageTitle(ctx.client, projectId, pageId, title),
  );
  emit(result, () => success(`Page renamed to ${bold(title)}.`));
}

// ─── Navigation ───────────────────────────────────────────────────────────────

export async function docsNav(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const nav = await withSpinner("Loading navigation", () =>
    api.getNav(ctx.client, projectId),
  );

  emit(nav, () => {
    heading(`Navigation ${nav.hasDraft ? dim("(unpublished draft)") : ""}`);
    if (nav.tabs.length === 0) {
      note("No tabs configured.");
      return;
    }
    for (const tab of nav.tabs) {
      const items = Array.isArray(tab.items) ? tab.items.length : 0;
      line(
        `  ${bold(tab.title ?? tab.label ?? tab.id ?? "—")} ${dim(`${items} item(s)`)}`,
      );
    }
    if (nav.hasDraft) note("octri docs nav publish");
  });
}

export async function docsNavPublish(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const result = await withSpinner("Publishing navigation", () =>
    api.publishNav(ctx.client, projectId),
  );
  emit(result, () => success("Navigation published."));
}

// ─── Guides ───────────────────────────────────────────────────────────────────

export async function docsGuides(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const guides = await withSpinner("Loading guides", () =>
    api.listGuides(ctx.client, projectId),
  );

  emit(guides, () => {
    heading(`Guides ${dim(`(${guides.length})`)}`);
    table(
      guides,
      [
        { header: "title", value: (g) => bold(g.title), flex: 1, minWidth: 20 },
        { header: "slug", value: (g) => dim(g.slug), flex: 2, minWidth: 14 },
        {
          header: "state",
          value: (g) =>
            g.hasUnpublishedChanges
              ? yellow("draft changes")
              : g.published
                ? green("published")
                : dim("unpublished"),
          flex: 5,
        },
        { header: "id", value: (g) => dim(g.id), flex: 7, minWidth: 24 },
      ],
      { emptyMessage: "No guides." },
    );
  });
}

export async function docsGuideShow(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const guideId = ctx.args.positionals[0];
  if (guideId === undefined) {
    throw new Error("Usage: octri docs guides show <guideId>");
  }
  const guide = await withSpinner("Loading guide", () =>
    api.getGuide(ctx.client, projectId, guideId),
  );

  emit(guide, () => {
    rule(String(guide["title"] ?? guideId));
    const body =
      (guide["draftContent"] as string | undefined) ??
      (guide["content"] as string | undefined) ??
      (guide["markdown"] as string | undefined);
    if (body === undefined) {
      line(dim(JSON.stringify(guide, null, 2)));
      return;
    }
    line(body);
  });
}

export async function docsGuidePublish(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const guideId = ctx.args.positionals[0];
  if (guideId === undefined) {
    throw new Error("Usage: octri docs guides publish <guideId>");
  }
  const result = await withSpinner("Publishing guide", () =>
    api.publishGuide(ctx.client, projectId, guideId),
  );
  emit(result, () => success("Guide published."));
}

// ─── Versions ─────────────────────────────────────────────────────────────────

export async function docsVersions(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const versions = await withSpinner("Loading published versions", () =>
    api.listVersions(ctx.client, projectId),
  );

  emit(versions, () => {
    heading(`Published versions ${dim(`(${versions.length})`)}`);
    table(
      versions,
      [
        {
          header: "",
          value: (v) => (v.isCurrent === true ? green("●") : dim("○")),
          minWidth: 1,
          flex: 9,
        },
        { header: "version", value: (v) => bold(v.version), flex: 4, minWidth: 10 },
        { header: "label", value: (v) => v.versionLabel ?? dim("—"), flex: 3 },
        {
          header: "endpoints",
          value: (v) => String(v.endpointCount ?? 0),
          flex: 7,
        },
        { header: "published", value: (v) => relativeTime(v.publishedAt), flex: 5 },
        { header: "spec", value: (v) => dim(v.specId), flex: 6, minWidth: 24 },
      ],
      {
        emptyMessage:
          "Nothing published. Run `octri docs versions publish <specId>`.",
      },
    );
  });
}

export async function docsVersionPublish(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const specId = ctx.args.positionals[0];
  if (specId === undefined) {
    throw new Error("Usage: octri docs versions publish <specId>");
  }
  const result = await withSpinner("Publishing version", () =>
    api.publishVersion(ctx.client, projectId, specId),
  );
  emit(result, () => success("Version published to the docs site."));
}

export async function docsVersionUnpublish(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const specId = ctx.args.positionals[0];
  if (specId === undefined) {
    throw new Error("Usage: octri docs versions unpublish <specId>");
  }
  const result = await withSpinner("Unpublishing version", () =>
    api.unpublishVersion(ctx.client, projectId, specId),
  );
  emit(result, () => success("Version removed from the docs site."));
}

export async function docsVersionLabel(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const [specId, ...rest] = ctx.args.positionals;
  const label = rest.join(" ");
  if (specId === undefined || label === "") {
    throw new Error("Usage: octri docs versions label <specId> <label>");
  }
  const result = await withSpinner("Setting label", () =>
    api.labelVersion(ctx.client, projectId, specId, label),
  );
  emit(result, () => success(`Version labelled ${bold(label)}.`));
}

export async function docsVersionDefault(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const specId = ctx.args.positionals[0];
  if (specId === undefined) {
    throw new Error("Usage: octri docs versions default <specId>");
  }
  const result = await withSpinner("Setting default version", () =>
    api.setDefaultVersion(ctx.client, projectId, specId),
  );
  emit(result, () => success("Default version updated."));
}

// ─── Custom domain ────────────────────────────────────────────────────────────

export async function docsDomain(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const result = await withSpinner("Loading custom domain", () =>
    api.getCustomDomain(ctx.client, projectId),
  );

  emit(result, () => {
    heading("Docs domain");
    if (result.domain === null) {
      note("No custom domain. Run `octri docs domain set docs.example.com`.");
      line(dim(`  CNAME target: ${result.cnameTarget}`));
      return;
    }
    keyValues([
      ["hostname", bold(result.domain.hostname)],
      ["status", domainStatus(result.domain.status)],
      ["added", relativeTime(result.domain.addedAt)],
      ["verified", relativeTime(result.domain.verifiedAt ?? undefined)],
      ...(result.domain.lastError == null
        ? []
        : ([["last error", red(result.domain.lastError)]] as const)),
    ]);

    if (result.instructions !== null) {
      line();
      heading("DNS records to add");
      for (const record of [
        result.instructions.cnameRecord,
        result.instructions.txtRecord,
      ]) {
        line(`  ${bold(record.type)} ${record.name}`);
        line(dim(`      ${record.value}`));
      }
      note("octri docs domain verify: once the records have propagated");
    }
  });
}

function domainStatus(status: string): string {
  if (status === "verified") return green(status);
  if (status === "failed") return red(status);
  return yellow(status);
}

export async function docsDomainSet(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const hostname = ctx.args.positionals[0] ?? flagString(ctx.args, "hostname");
  if (hostname === undefined) {
    throw new Error("Usage: octri docs domain set <hostname>");
  }
  const result = await withSpinner(`Registering ${bold(hostname)}`, () =>
    api.setCustomDomain(ctx.client, projectId, hostname),
  );
  emit(result, () => {
    success(`${hostname} registered. Now add the DNS records.`);
    note("octri docs domain: shows the exact CNAME and TXT values");
  });
}

export async function docsDomainVerify(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const result = await withSpinner("Checking DNS", () =>
    api.verifyCustomDomain(ctx.client, projectId),
  );
  emit(result, () => {
    if (result.domain?.status === "verified") {
      success(`${result.domain.hostname} is verified and serving.`);
      return;
    }
    warn(
      `Not verified yet${result.domain?.lastError == null ? "" : `: ${result.domain.lastError}`}`,
    );
    note("DNS can take a few minutes to propagate. Re-run to check again.");
  });
}

export async function docsDomainRemove(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  if (!flagBool(ctx.args, "yes")) {
    warn("Removing the domain stops serving docs on it. Re-run with --yes.");
    return;
  }
  await withSpinner("Removing custom domain", () =>
    api.removeCustomDomain(ctx.client, projectId),
  );
  emit({ removed: true }, () => success("Custom domain removed."));
}

// ─── Redirects ────────────────────────────────────────────────────────────────
//
// Redirects and the home page are part of the docs IA, so they are drafted:
// every write here lands in the draft and reaches readers on
// `octri docs nav publish`, exactly as in the API Studio.

const PUBLISH_HINT = "octri docs nav publish: send the draft live";

export async function docsRedirects(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const result = await withSpinner("Loading redirects", () =>
    api.getRedirects(ctx.client, projectId),
  );

  emit({ projectId, ...result }, () => {
    heading(
      `Redirects ${dim(`(${result.redirects.length})`)} ${result.pending ? yellow("unpublished draft") : ""}`,
    );
    table(
      result.redirects,
      [
        { header: "from", value: (r) => bold(r.from), flex: 1, minWidth: 16 },
        { header: "to", value: (r) => r.to, flex: 1, minWidth: 16 },
        {
          header: "",
          value: (r) => (r.force === true ? dim("page rename") : ""),
          flex: 5,
        },
      ],
      { emptyMessage: "No redirects." },
    );
    if (result.pending) note(PUBLISH_HINT);
  });
}

/**
 * `octri docs redirects add <from> <to>`. A rule for the same old path is
 * replaced in place rather than duplicated, which the API would refuse.
 */
export async function docsRedirectAdd(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const [from, to] = ctx.args.positionals;
  if (from === undefined || to === undefined) {
    throw new Error("Usage: octri docs redirects add <from> <to>  (e.g. /old/* /new/*)");
  }

  const current = await api.getRedirects(ctx.client, projectId);
  const rules = current.redirects.filter((r) => r.from !== from);
  rules.push({ from, to });

  const result = await withSpinner("Drafting redirect", () =>
    api.putRedirects(ctx.client, projectId, rules),
  );
  emit({ projectId, ...result }, () => {
    success(`Drafted ${bold(from)} → ${to}`);
    note(PUBLISH_HINT);
  });
}

export async function docsRedirectRemove(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const from = ctx.args.positionals[0];
  if (from === undefined) {
    throw new Error("Usage: octri docs redirects remove <from>");
  }

  const current = await api.getRedirects(ctx.client, projectId);
  const rules = current.redirects.filter((r) => r.from !== from);
  if (rules.length === current.redirects.length) {
    throw new Error(`No redirect from ${from}. Run \`octri docs redirects\`.`);
  }

  const result = await withSpinner("Drafting removal", () =>
    api.putRedirects(ctx.client, projectId, rules),
  );
  emit({ projectId, ...result }, () => {
    success(`Drafted removal of ${bold(from)}.`);
    note(PUBLISH_HINT);
  });
}

// ─── Home page ────────────────────────────────────────────────────────────────

export async function docsHome(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const result = await withSpinner("Loading home page", () =>
    api.getDocsHome(ctx.client, projectId),
  );

  emit({ projectId, ...result }, () => {
    heading(`Docs home page ${result.pending ? yellow("unpublished draft") : ""}`);
    if (result.home === null) {
      keyValues([["page", dim("none")]]);
      note("octri docs home set <guideId>: serve a guide at /");
    } else {
      keyValues([
        ["page", bold(result.home.guideId)],
        ["sidebar", result.home.hideSidebar ? dim("hidden") : "shown"],
      ]);
    }
    if (result.pending) note(PUBLISH_HINT);
  });
}

/** `octri docs home set <guideId> [--hide-sidebar|--no-hide-sidebar]` */
export async function docsHomeSet(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const guideId = ctx.args.positionals[0];
  if (guideId === undefined) {
    throw new Error("Usage: octri docs home set <guideId> [--hide-sidebar]");
  }
  const hide = ctx.args.flags["hide-sidebar"];

  const result = await withSpinner("Drafting home page", () =>
    api.putDocsHome(
      ctx.client,
      projectId,
      guideId,
      typeof hide === "boolean" ? hide : undefined,
    ),
  );
  emit({ projectId, ...result }, () => {
    success(`Drafted ${bold(guideId)} as the home page.`);
    note(PUBLISH_HINT);
  });
}

export async function docsHomeClear(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const result = await withSpinner("Drafting no home page", () =>
    api.putDocsHome(ctx.client, projectId, null),
  );
  emit({ projectId, ...result }, () => {
    success("Drafted: no home page.");
    note(PUBLISH_HINT);
  });
}

// ─── Nav buttons ──────────────────────────────────────────────────────────────
//
// The top nav's call-to-action buttons have no draft: they apply on save.

const BUTTON_STYLES: readonly api.NavButtonStyle[] = ["plain", "outline", "primary"];

export async function docsButtons(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const nav = await withSpinner("Loading nav buttons", () =>
    api.getNav(ctx.client, projectId),
  );
  const buttons = nav.buttons ?? [];

  emit({ projectId, buttons }, () => {
    heading(`Nav buttons ${dim(`(${buttons.length} of 3)`)}`);
    table(
      buttons,
      [
        { header: "label", value: (b) => bold(b.label), flex: 3, minWidth: 10 },
        { header: "style", value: (b) => b.style, flex: 5 },
        { header: "url", value: (b) => dim(b.url), flex: 1, minWidth: 16 },
      ],
      { emptyMessage: "No nav buttons." },
    );
  });
}

/**
 * `octri docs buttons add <label> <url> [--style plain|outline|primary]`. A
 * button with the same label is replaced in place.
 */
export async function docsButtonAdd(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const [label, url] = ctx.args.positionals;
  if (label === undefined || url === undefined) {
    throw new Error(
      "Usage: octri docs buttons add <label> <url> [--style plain|outline|primary]",
    );
  }
  const style = (flagString(ctx.args, "style") ?? "plain") as api.NavButtonStyle;
  if (!BUTTON_STYLES.includes(style)) {
    throw new Error(`Style must be one of ${BUTTON_STYLES.join(", ")}.`);
  }

  const nav = await api.getNav(ctx.client, projectId);
  const buttons = [...(nav.buttons ?? [])];
  const index = buttons.findIndex((b) => b.label === label);
  if (index === -1) buttons.push({ label, url, style });
  else buttons[index] = { label, url, style };

  const saved = await withSpinner("Saving nav buttons", () =>
    api.putNavButtons(ctx.client, projectId, buttons),
  );
  emit({ projectId, buttons: saved }, () =>
    success(`${bold(label)} is in the nav. Buttons go live on save.`),
  );
}

export async function docsButtonRemove(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const label = ctx.args.positionals[0];
  if (label === undefined) {
    throw new Error("Usage: octri docs buttons remove <label>");
  }

  const nav = await api.getNav(ctx.client, projectId);
  const buttons = (nav.buttons ?? []).filter((b) => b.label !== label);
  if (buttons.length === (nav.buttons ?? []).length) {
    throw new Error(`No nav button labelled "${label}".`);
  }

  const saved = await withSpinner("Saving nav buttons", () =>
    api.putNavButtons(ctx.client, projectId, buttons),
  );
  emit({ projectId, buttons: saved }, () =>
    success(`Removed ${bold(label)} from the nav.`),
  );
}
