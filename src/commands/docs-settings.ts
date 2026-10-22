/**
 * `octri docs theme|seo|socials|feedback|playground|custom-code`: the docs
 * settings the studio's octri.json carries besides the IA. None of them has a
 * draft: a `set` is live on the docs site as soon as it returns.
 *
 * Every `set` takes `key=value` words, the keys spelled as the API spells them
 * (`primaryColor=#ff6a00`, `defaultAuth.type=bearer`). See parseAssignments.
 */

import { readFileSync } from "node:fs";

import * as api from "../api.js";
import type { Context } from "../context.js";
import { bold, dim, green, yellow } from "../ui/ansi.js";
import { emit, heading, keyValues, note, success, warn } from "../ui/output.js";
import { withSpinner } from "../ui/spinner.js";

// ─── key=value parsing ────────────────────────────────────────────────────────

export interface AssignmentKinds {
  /** Keys whose value is a number. */
  numbers?: readonly string[];
  /** Keys whose value is a comma-separated list; an empty value is []. */
  lists?: readonly string[];
  /** Keys whose value is JSON. */
  json?: readonly string[];
}

/**
 * Turns `key=value` words into a patch. `true` and `false` become booleans and
 * `@path` reads the value from a file (`css=@docs.css`); the keys named in
 * `kinds` are parsed as numbers, lists or JSON. A dotted key sets one field of
 * a nested object, so `defaultAuth.type=bearer` yields `{ defaultAuth: { type } }`.
 */
export function parseAssignments(
  words: readonly string[],
  kinds: AssignmentKinds = {},
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const word of words) {
    const at = word.indexOf("=");
    if (at <= 0) throw new Error(`Expected key=value, got "${word}".`);
    const key = word.slice(0, at);
    const raw = word.slice(at + 1);
    const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;

    let value: unknown = text;
    if (kinds.numbers?.includes(key) === true) {
      value = Number(text);
      if (text.trim() === "" || !Number.isFinite(value)) {
        throw new Error(`${key} takes a number, got "${text}".`);
      }
    } else if (kinds.lists?.includes(key) === true) {
      value = text.split(",").map((item) => item.trim()).filter((item) => item !== "");
    } else if (kinds.json?.includes(key) === true) {
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error(`${key} takes JSON, which "${text.slice(0, 40)}" is not.`);
      }
    } else if (text === "true" || text === "false") {
      value = text === "true";
    }

    const path = key.split(".");
    let target = patch;
    for (const part of path.slice(0, -1)) {
      const next = target[part];
      if (typeof next !== "object" || next === null || Array.isArray(next)) target[part] = {};
      target = target[part] as Record<string, unknown>;
    }
    target[path[path.length - 1] as string] = value;
  }
  return patch;
}

function assignmentsOf(ctx: Context, usage: string, kinds?: AssignmentKinds): Record<string, unknown> {
  if (ctx.args.positionals.length === 0) throw new Error(`Usage: ${usage}`);
  return parseAssignments(ctx.args.positionals, kinds);
}

/**
 * The API drops a theme or SEO key it does not know without an error, so a
 * typo would read as a save. A key the saved copy does not hold was dropped.
 */
function droppedKeys(sent: Record<string, unknown>, saved: Record<string, unknown>): string[] {
  return Object.keys(sent).filter((key) => !(key in saved));
}

function display(value: unknown): string {
  if (value === undefined || value === null || value === "") return dim("not set");
  if (value === true) return green("on");
  if (value === false) return dim("off");
  if (typeof value === "string") {
    const first = value.split("\n")[0] ?? "";
    return value.includes("\n") ? `${first} ${dim(`(${value.split("\n").length} lines)`)}` : value;
  }
  return JSON.stringify(value);
}

function settingRows(settings: Record<string, unknown>): [string, string][] {
  return Object.keys(settings)
    .sort()
    .map((key) => [key, display(settings[key])]);
}

// ─── Theme, SEO, socials ──────────────────────────────────────────────────────

type ProjectSection = "theme" | "seo" | "socials";

const SECTION_TITLE: Record<ProjectSection, string> = {
  theme: "Docs appearance",
  seo: "Docs SEO",
  socials: "Docs social links",
};

async function showSection(ctx: Context, section: ProjectSection): Promise<void> {
  const projectId = ctx.projectId();
  const settings = await withSpinner(`Loading ${section}`, () =>
    api.getDocsSettings(ctx.client, projectId),
  );
  const values = settings[section];
  emit({ projectId, [section]: values }, () => {
    heading(SECTION_TITLE[section]);
    if (Object.keys(values).length === 0) note("Nothing set yet.");
    keyValues(settingRows(values));
    note(`octri docs ${section} set key=value …`);
  });
}

async function setSection(
  ctx: Context,
  section: ProjectSection,
  patch: Record<string, unknown>,
): Promise<void> {
  const projectId = ctx.projectId();
  const saved = await withSpinner(`Saving ${section}`, () =>
    api.updateDocsSettings(ctx.client, projectId, { [section]: patch }),
  );
  // Socials is the one section the API refuses unknown keys in, with an error.
  const dropped = section === "socials" ? [] : droppedKeys(patch, saved[section]);
  const kept = Object.keys(patch).filter((key) => !dropped.includes(key));
  emit({ projectId, [section]: saved[section], ...(dropped.length > 0 ? { ignored: dropped } : {}) }, () => {
    if (dropped.length > 0) {
      warn(`Not ${section === "theme" ? "theme" : "SEO"} settings, so the API ignored them: ${dropped.join(", ")}`);
    }
    if (kept.length > 0) {
      success(`Saved ${kept.map((key) => bold(key)).join(", ")}. Live on the docs site now.`);
    }
  });
}

export function docsTheme(ctx: Context): Promise<void> {
  return showSection(ctx, "theme");
}

/** `octri docs theme set primaryColor=#ff6a00 colorScheme=dark customCss=@docs.css` */
export function docsThemeSet(ctx: Context): Promise<void> {
  return setSection(
    ctx,
    "theme",
    assignmentsOf(ctx, "octri docs theme set key=value … (e.g. primaryColor=#ff6a00 codeTheme=nord)"),
  );
}

export function docsSeo(ctx: Context): Promise<void> {
  return showSection(ctx, "seo");
}

/** `octri docs seo set metaTitle="Acme API" indexable=true` */
export function docsSeoSet(ctx: Context): Promise<void> {
  return setSection(
    ctx,
    "seo",
    assignmentsOf(ctx, "octri docs seo set key=value … (e.g. metaDescription=\"…\" indexable=true)"),
  );
}

export function docsSocials(ctx: Context): Promise<void> {
  return showSection(ctx, "socials");
}

/**
 * `octri docs socials set github=https://github.com/acme x=` where an empty
 * value removes a link. `custom=@links.json` replaces the custom links whole:
 * a JSON array of `{ label, url, icon }`.
 */
export function docsSocialsSet(ctx: Context): Promise<void> {
  return setSection(
    ctx,
    "socials",
    assignmentsOf(ctx, "octri docs socials set <platform>=<url> … (empty url removes; custom=@links.json)", {
      json: ["custom"],
    }),
  );
}

// ─── Feedback widget ──────────────────────────────────────────────────────────

export async function docsFeedback(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const settings = await withSpinner("Loading feedback", () =>
    api.getDocsSettings(ctx.client, projectId),
  );
  emit({ projectId, feedbackEnabled: settings.feedbackEnabled }, () => {
    heading("Page feedback");
    keyValues([["widget", display(settings.feedbackEnabled)]]);
    note(`octri docs feedback ${settings.feedbackEnabled ? "off" : "on"}`);
  });
}

async function setFeedback(ctx: Context, enabled: boolean): Promise<void> {
  const projectId = ctx.projectId();
  const saved = await withSpinner("Saving feedback", () =>
    api.updateDocsSettings(ctx.client, projectId, { feedbackEnabled: enabled }),
  );
  emit({ projectId, feedbackEnabled: saved.feedbackEnabled }, () =>
    success(`Page feedback is ${saved.feedbackEnabled ? "on" : "off"}.`),
  );
}

export function docsFeedbackOn(ctx: Context): Promise<void> {
  return setFeedback(ctx, true);
}

export function docsFeedbackOff(ctx: Context): Promise<void> {
  return setFeedback(ctx, false);
}

// ─── Playground ───────────────────────────────────────────────────────────────

export async function docsPlayground(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const result = await withSpinner("Loading playground", () =>
    api.getPlayground(ctx.client, projectId),
  );
  emit({ projectId, ...result }, () => {
    const { playground, effective } = result;
    heading(`API playground ${playground.enabled ? green("on") : dim("off")}`);
    keyValues([
      ["baseUrl", playground.baseUrl === "" ? dim(`inherits ${effective?.baseUrl ?? "the project's"}`) : playground.baseUrl],
      ["defaultAuth.type", playground.defaultAuth.type],
      ["defaultAuth.headerName", playground.defaultAuth.headerName],
      ["allowedOrigins", playground.allowedOrigins.length === 0 ? dim("none") : playground.allowedOrigins.join(", ")],
      ["requestTimeoutMs", String(playground.requestTimeoutMs)],
    ]);
    note("octri docs playground set key=value …");
  });
}

/**
 * `octri docs playground set enabled=true allowedOrigins=https://a.dev,https://b.dev`.
 * The API takes `defaultAuth` only whole, so one half of it is merged onto the
 * saved other half before sending.
 */
export async function docsPlaygroundSet(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const patch = assignmentsOf(
    ctx,
    "octri docs playground set key=value … (enabled, baseUrl, defaultAuth.type, defaultAuth.headerName, allowedOrigins, requestTimeoutMs)",
    { numbers: ["requestTimeoutMs"], lists: ["allowedOrigins"] },
  ) as Partial<api.PlaygroundSettings>;

  if (patch.defaultAuth !== undefined) {
    const current = await api.getPlayground(ctx.client, projectId);
    patch.defaultAuth = { ...current.playground.defaultAuth, ...patch.defaultAuth };
  }

  const result = await withSpinner("Saving playground", () =>
    api.updatePlayground(ctx.client, projectId, patch),
  );
  emit({ projectId, ...result }, () =>
    success(`Saved ${Object.keys(patch).map((key) => bold(key)).join(", ")}. Live on the docs site now.`),
  );
}

// ─── Custom code ──────────────────────────────────────────────────────────────

export async function docsCustomCode(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const customCode = await withSpinner("Loading custom code", () =>
    api.getCustomCode(ctx.client, projectId),
  );
  emit({ projectId, customCode }, () => {
    heading(`Custom code ${customCode.enabled ? green("on") : dim("off")}`);
    const size = (text: string): string => (text === "" ? dim("empty") : `${text.length} chars`);
    keyValues([
      ["css", size(customCode.css)],
      ["headHtml", size(customCode.headHtml)],
      ["bodyEndHtml", size(customCode.bodyEndHtml)],
    ]);
    note("--json prints the code itself");
  });
}

/** `octri docs custom-code set enabled=true css=@docs.css headHtml=@head.html` */
export async function docsCustomCodeSet(ctx: Context): Promise<void> {
  const projectId = ctx.projectId();
  const patch = assignmentsOf(
    ctx,
    "octri docs custom-code set key=value … (enabled, css=@file, headHtml=@file, bodyEndHtml=@file)",
  ) as Partial<api.CustomCodeSettings>;

  const customCode = await withSpinner("Saving custom code", () =>
    api.updateCustomCode(ctx.client, projectId, patch),
  );
  emit({ projectId, customCode }, () => {
    success(`Saved ${Object.keys(patch).map((key) => bold(key)).join(", ")}.`);
    if (!customCode.enabled) note(yellow("Custom code is off, so readers do not get it yet: enabled=true"));
  });
}
