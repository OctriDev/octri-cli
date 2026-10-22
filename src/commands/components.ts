/**
 * `octri docs components …`: the project's custom docs components, the ones
 * the API Studio's Files tab edits as JSX or MDX.
 *
 * `push` is create-or-update by name, so a components folder kept in a repo
 * can be pushed on every commit without tracking ids.
 */

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

import * as api from "../api.js";
import { flagBool, flagString } from "../args.js";
import { bold, dim } from "../ui/ansi.js";
import { rule } from "../ui/box.js";
import { emit, heading, line, note, success, warn } from "../ui/output.js";
import { withSpinner } from "../ui/spinner.js";
import { table } from "../ui/table.js";

import type { Context } from "../context.js";

export async function componentsList(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const components = await withSpinner("Loading components", () =>
    api.listComponents(ctx.client, projectId),
  );

  emit({ projectId, components }, () => {
    heading(`Custom components ${dim(`(${components.length})`)}`);
    table(
      components,
      [
        { header: "name", value: (c) => bold(c.name), flex: 3, minWidth: 14 },
        { header: "source", value: (c) => c.sourceType, flex: 6 },
        { header: "props", value: (c) => String(c.props.length), align: "right", flex: 7 },
        { header: "description", value: (c) => dim(c.description), flex: 1 },
        { header: "id", value: (c) => dim(c.id), flex: 4, minWidth: 24 },
      ],
      { emptyMessage: "No custom components. Run `octri docs components push <file.jsx>`." },
    );
  });
}

export async function componentsBuiltIn(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const names = await withSpinner("Loading built-in components", () =>
    api.listBuiltInComponents(ctx.client, projectId),
  );
  emit({ projectId, components: names }, () => {
    heading(`Built-in components ${dim(`(${names.length})`)}`);
    line(`  ${names.join(dim(", "))}`);
    note("A custom component cannot take one of these names.");
  });
}

export async function componentsShow(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const ref = ctx.args.positionals[0];
  if (ref === undefined) throw new Error("Usage: octri docs components show <name|id>");

  const found = await api.findComponent(ctx.client, projectId, ref);
  if (found === undefined) throw new Error(`No component named "${ref}".`);
  const component = await withSpinner(`Loading ${bold(found.name)}`, () =>
    api.getComponent(ctx.client, projectId, found.id),
  );

  emit(component, () => {
    rule(component.name);
    if (component.description !== "") line(dim(component.description));
    for (const prop of component.props) {
      line(`  ${bold(prop.name)} ${dim(prop.type)}${prop.defaultValue ? dim(` = ${prop.defaultValue}`) : ""}`);
    }
    line();
    line(
      component.sourceType === "mdx"
        ? (component.sourceMdx ?? "")
        : JSON.stringify(component.tree ?? null, null, 2),
    );
    if (component.customCss) {
      rule("css");
      line(component.customCss);
    }
  });
}

/** `Banner.jsx` → `Banner`, `call-out.mdx` → `CallOut`. */
export function componentNameFromFile(file: string): string {
  return basename(file, extname(file))
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * `octri docs components push <file.jsx|file.mdx> [--name Banner]
 *   [--description "…"] [--css styles.css] [--props props.json]`
 *
 * A `.mdx` file makes an MDX component; anything else is sent as the JSX of a
 * visual component, which the API parses to the tree it stores. That file is
 * the markup alone: one root element, HTML attribute names (`class`, not
 * `className`), props as `{name}`, and no imports, exports or function.
 */
export async function componentsPush(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const file = ctx.args.positionals[0];
  if (file === undefined) {
    throw new Error(
      "Usage: octri docs components push <file.jsx|file.mdx> [--name Name] [--css file] [--props props.json]",
    );
  }

  const name = flagString(ctx.args, "name") ?? componentNameFromFile(file);
  const source = readFileSync(file, "utf8");
  const isMdx = extname(file).toLowerCase() === ".mdx";
  const cssFile = flagString(ctx.args, "css");
  const propsFile = flagString(ctx.args, "props");
  const description = flagString(ctx.args, "description");

  const input: api.ComponentInput = {
    sourceType: isMdx ? "mdx" : "visual",
    ...(isMdx ? { sourceMdx: source } : { sourceJsx: source }),
    ...(cssFile === undefined ? {} : { customCss: readFileSync(cssFile, "utf8") }),
    ...(propsFile === undefined
      ? {}
      : { props: JSON.parse(readFileSync(propsFile, "utf8")) as api.ComponentProp[] }),
    ...(description === undefined ? {} : { description }),
  };

  const result = await withSpinner(`Saving ${bold(name)}`, () =>
    api.saveComponent(ctx.client, projectId, name, input),
  );

  emit(result, () => {
    success(`${bold(name)} ${result.created ? "created" : "updated"}.`);
    for (const warning of result.warnings ?? []) warn(warning);
  });
}

export async function componentsRemove(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const ref = ctx.args.positionals[0];
  if (ref === undefined) throw new Error("Usage: octri docs components remove <name|id> --yes");

  const found = await api.findComponent(ctx.client, projectId, ref);
  if (found === undefined) throw new Error(`No component named "${ref}".`);
  if (!flagBool(ctx.args, "yes")) {
    warn(`Pages that use <${found.name}> will stop rendering it. Re-run with --yes.`);
    return;
  }
  await withSpinner(`Removing ${bold(found.name)}`, () =>
    api.deleteComponent(ctx.client, projectId, found.id),
  );
  emit({ deleted: true, id: found.id, name: found.name }, () =>
    success(`${bold(found.name)} removed.`),
  );
}
