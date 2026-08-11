/**
 * `octri projects …` — list, inspect, create, and pick the working project.
 */

import { flagString } from "../args.js";
import * as api from "../api.js";
import { updateProfile } from "../config.js";
import type { Context } from "../context.js";
import { accent, bold, dim, gray, green } from "../ui/ansi.js";
import {
  emit,
  heading,
  keyValues,
  line,
  relativeTime,
  success,
} from "../ui/output.js";
import * as prompt from "../ui/prompt.js";
import { withSpinner } from "../ui/spinner.js";
import { table } from "../ui/table.js";

export async function projectsList(ctx: Context): Promise<void> {
  const projects = await withSpinner("Loading projects", () =>
    api.listProjects(ctx.client),
  );
  const current = ctx.settings.defaultProject;

  emit({ projects, current }, () => {
    heading(`Projects ${dim(`(${projects.length})`)}`);
    table(
      projects,
      [
        {
          header: "",
          value: (p) => (p.id === current ? green("●") : dim("○")),
          minWidth: 1,
          flex: 9,
        },
        { header: "name", value: (p) => bold(p.name), flex: 2, minWidth: 12 },
        { header: "id", value: (p) => dim(p.id), flex: 8, minWidth: 24 },
        {
          header: "updated",
          value: (p) => relativeTime(p.updatedAt ?? p.createdAt),
          flex: 5,
        },
      ],
      { emptyMessage: "No projects yet — `octri projects create <name>`." },
    );
    if (current !== undefined) {
      line(dim(`  ● = current project (octri projects use <id> to change)`));
    }
  });
}

export async function projectsShow(ctx: Context): Promise<void> {
  const id = ctx.projectId(ctx.args.positionals[0]);
  const project = await withSpinner("Loading project", () =>
    api.getProject(ctx.client, id),
  );

  emit(project, () => {
    heading(project.name);
    keyValues([
      ["id", project.id],
      ["slug", project.slug ?? dim("—")],
      ["description", project.description ?? dim("—")],
      ["docs", project.docsUrl ?? dim("—")],
      ["created", relativeTime(project.createdAt)],
    ]);
  });
}

export async function projectsCreate(ctx: Context): Promise<void> {
  const name =
    ctx.args.positionals.join(" ") || (await prompt.text("Project name"));
  if (name === "") throw new Error("Usage: octri projects create <name>");

  const description = flagString(ctx.args, "description");
  const project = await withSpinner(`Creating ${bold(name)}`, () =>
    api.createProject(ctx.client, {
      name,
      ...(description === undefined ? {} : { description }),
    }),
  );

  // A freshly created project is almost always the one you want to work on.
  updateProfile({ defaultProject: project.id });

  emit(project, () => {
    success(`Created ${bold(project.name)} ${dim(project.id)}`);
    line(dim("  Selected as the current project."));
  });
}

/** `octri projects use [id]` — with no id, offers an interactive picker. */
export async function projectsUse(ctx: Context): Promise<void> {
  let id = ctx.args.positionals[0];

  if (id === undefined) {
    const projects = await withSpinner("Loading projects", () =>
      api.listProjects(ctx.client),
    );
    id = await prompt.select(
      "Select a project",
      projects.map((p) => ({ label: p.name, value: p.id, hint: p.id })),
    );
  }

  // Fail loudly on a typo'd id rather than storing an unusable default.
  const project = await api.getProject(ctx.client, id);
  updateProfile({ defaultProject: project.id });

  emit({ project: project.id, name: project.name }, () =>
    success(`Working project: ${bold(project.name)} ${dim(project.id)}`),
  );
}

export function projectsCurrent(ctx: Context): void {
  const id = ctx.settings.defaultProject;
  emit({ project: id ?? null }, () => {
    if (id === undefined) {
      line(dim("No project selected. Run `octri projects use`."));
      return;
    }
    line(`${accent("●")} ${id} ${gray("·")} ${dim(ctx.settings.profile)}`);
  });
}
