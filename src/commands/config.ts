/**
 * `octri config …` — inspect and edit the stored profile.
 */

import { flagString, type ParsedArgs } from "../args.js";
import {
  configPath,
  normalizeApiUrl,
  readConfig,
  readProfile,
  updateProfile,
  useProfile,
} from "../config.js";
import type { Context } from "../context.js";
import { bold, dim } from "../ui/ansi.js";
import { emit, heading, keyValues, line, success } from "../ui/output.js";

/** Keys a user may set. Tokens are deliberately not editable by hand. */
const EDITABLE = new Set([
  "apiUrl",
  "defaultProject",
  "defaultLanguages",
  "apiKey",
]);

export function configList(ctx: Context): void {
  const profile = readProfile(flagString(ctx.args, "profile"));
  const redacted = {
    ...profile,
    accessToken: profile.accessToken === undefined ? undefined : "<stored>",
    refreshToken: profile.refreshToken === undefined ? undefined : "<stored>",
    apiKey: profile.apiKey === undefined ? undefined : "<stored>",
  };

  emit({ path: configPath(), profile: ctx.settings.profile, values: redacted }, () => {
    heading(`Profile ${bold(ctx.settings.profile)}`);
    keyValues(
      Object.entries(redacted)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)] as const),
    );
    line(dim(`  ${configPath()}`));
  });
}

export function configSet(args: ParsedArgs): void {
  const [key, ...valueParts] = args.positionals;
  const value = valueParts.join(" ");

  if (key === undefined || value === "") {
    throw new Error(
      `Usage: octri config set <key> <value>. Editable keys: ${[...EDITABLE].join(", ")}.`,
    );
  }
  if (!EDITABLE.has(key)) {
    throw new Error(
      `\`${key}\` is not editable. Editable keys: ${[...EDITABLE].join(", ")}.`,
    );
  }

  const patch: Record<string, unknown> =
    key === "apiUrl"
      ? { apiUrl: normalizeApiUrl(value) }
      : key === "defaultLanguages"
        ? { defaultLanguages: value.split(",").map((s) => s.trim()) }
        : { [key]: value };

  const updated = updateProfile(patch) as unknown as Record<string, unknown>;
  emit({ key, value: patch[key] }, () =>
    success(`${key} = ${String(updated[key])}`),
  );
}

export function configUse(args: ParsedArgs): void {
  const name = args.positionals[0];
  if (name === undefined) throw new Error("Usage: octri config use <profile>");

  const apiUrl = flagString(args, "api-url");
  const profile = useProfile(
    name,
    apiUrl === undefined ? undefined : normalizeApiUrl(apiUrl),
  );

  emit({ profile: name, apiUrl: profile.apiUrl }, () =>
    success(`Now using profile ${bold(name)} ${dim(`→ ${profile.apiUrl}`)}`),
  );
}

export function configPathCommand(): void {
  emit({ path: configPath(), current: readConfig().current }, () => {
    line(configPath());
  });
}
