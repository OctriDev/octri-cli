/**
 * Persisted CLI state — `~/.octri/config.json`, written 0600 because it holds
 * session tokens and (optionally) an API key.
 *
 * Profiles let one machine talk to local, staging and production without
 * re-authenticating each time: `--profile local` or `OCTRI_PROFILE=local`.
 * Resolution order for every value is flag → env → profile → default.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_API_URL = "https://api.octri.dev/api/v1";
export const LOCAL_API_URL = "http://localhost:3001/api/v1";

/**
 * Every optional field is explicitly `| undefined`: `exactOptionalPropertyTypes`
 * is on repo-wide, and clearing a stored credential means passing `undefined`.
 */
export interface Profile {
  apiUrl: string;
  /** Session JWT from `octri auth login` (or `OCTRI_TOKEN`). */
  accessToken?: string | undefined;
  /** Refresh token cookie, used to re-mint an expired access token. */
  refreshToken?: string | undefined;
  /** Long-lived key for the public /api/v1 surface. */
  apiKey?: string | undefined;
  email?: string | undefined;
  orgId?: string | undefined;
  /** Project used when a command omits `--project`. */
  defaultProject?: string | undefined;
  /** Languages `octri sdk build` targets by default. */
  defaultLanguages?: string[] | undefined;
}

export interface ConfigFile {
  version: 1;
  current: string;
  profiles: Record<string, Profile>;
}

const EMPTY: ConfigFile = {
  version: 1,
  current: "default",
  profiles: { default: { apiUrl: DEFAULT_API_URL } },
};

// ─── Paths ────────────────────────────────────────────────────────────────────

export function configDir(): string {
  const override = process.env["OCTRI_CONFIG_DIR"];
  if (override !== undefined && override !== "") return override;
  return join(homedir(), ".octri");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

/** Working directory for downloaded artifacts and lab runs. */
export function cacheDir(): string {
  return join(configDir(), "cache");
}

// ─── Read / write ─────────────────────────────────────────────────────────────

export function readConfig(): ConfigFile {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ConfigFile>;
    if (parsed.profiles === undefined) return { ...EMPTY };
    return {
      version: 1,
      current: parsed.current ?? "default",
      profiles: parsed.profiles,
    };
  } catch {
    // A missing or corrupt file is not an error — it is a first run.
    return { ...EMPTY, profiles: { ...EMPTY.profiles } };
  }
}

export function writeConfig(config: ConfigFile): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    // Re-assert the mode: writeFileSync only applies it when creating the file.
    chmodSync(path, 0o600);
  } catch {
    // Non-POSIX filesystems; the file still exists, just without the mode.
  }
}

// ─── Resolution ───────────────────────────────────────────────────────────────

export function profileName(explicit?: string): string {
  return explicit ?? process.env["OCTRI_PROFILE"] ?? readConfig().current;
}

export function readProfile(explicit?: string): Profile {
  const config = readConfig();
  const name = profileName(explicit);
  return config.profiles[name] ?? { apiUrl: DEFAULT_API_URL };
}

export function updateProfile(
  patch: Partial<Profile>,
  explicit?: string,
): Profile {
  const config = readConfig();
  const name = profileName(explicit);
  const merged: Profile = {
    ...(config.profiles[name] ?? { apiUrl: DEFAULT_API_URL }),
    ...patch,
  };
  // `undefined` in the patch means "clear this key", not "leave it alone".
  const record = merged as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete record[key];
  }
  config.profiles[name] = merged;
  config.current = name;
  writeConfig(config);
  return merged;
}

export function useProfile(name: string, apiUrl?: string): Profile {
  const config = readConfig();
  config.profiles[name] ??= { apiUrl: apiUrl ?? DEFAULT_API_URL };
  if (apiUrl !== undefined) {
    (config.profiles[name] as Profile).apiUrl = apiUrl;
  }
  config.current = name;
  writeConfig(config);
  return config.profiles[name] as Profile;
}

// ─── Effective settings ───────────────────────────────────────────────────────

export interface Resolved {
  profile: string;
  apiUrl: string;
  accessToken: string | undefined;
  refreshToken: string | undefined;
  apiKey: string | undefined;
  defaultProject: string | undefined;
  defaultLanguages: string[];
}

export interface ResolveOverrides {
  profile?: string;
  apiUrl?: string;
  project?: string;
  token?: string;
  apiKey?: string;
}

/**
 * Folds flags, env and the stored profile into the values a command actually
 * runs with. `OCTRI_API_URL=local` is accepted as shorthand for localhost:3001.
 */
export function resolve(overrides: ResolveOverrides = {}): Resolved {
  const name = profileName(overrides.profile);
  const profile = readProfile(overrides.profile);

  const rawUrl =
    overrides.apiUrl ??
    process.env["OCTRI_API_URL"] ??
    profile.apiUrl ??
    DEFAULT_API_URL;

  return {
    profile: name,
    apiUrl: normalizeApiUrl(rawUrl),
    accessToken: overrides.token ?? process.env["OCTRI_TOKEN"] ?? profile.accessToken,
    refreshToken: profile.refreshToken,
    apiKey: overrides.apiKey ?? process.env["OCTRI_API_KEY"] ?? profile.apiKey,
    defaultProject:
      overrides.project ??
      process.env["OCTRI_PROJECT_ID"] ??
      profile.defaultProject,
    defaultLanguages: profile.defaultLanguages ?? [],
  };
}

/** Accepts `local`, a bare host, or a full URL; always returns an /api/v1 root. */
export function normalizeApiUrl(input: string): string {
  if (input === "local" || input === "localhost") return LOCAL_API_URL;
  let url = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  if (!url.endsWith("/api/v1")) url = `${url}/api/v1`;
  return url;
}
