/**
 * Persisted CLI state: `~/.octri/config.json`, written 0600 because it holds
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

/**
 * Profile names index a plain object and come from flags, env and the config
 * file, so `__proto__` would reach the prototype instead of a profile.
 */
const RESERVED_PROFILE_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function assertProfileName(name: string): string {
  if (name === "" || RESERVED_PROFILE_NAMES.has(name)) {
    throw new Error(`"${name}" is not a usable profile name.`);
  }
  return name;
}

function toProfileMap(input: unknown): Record<string, Profile> {
  const profiles = Object.create(null) as Record<string, Profile>;
  if (input === null || typeof input !== "object") return profiles;
  for (const [name, value] of Object.entries(input)) {
    if (RESERVED_PROFILE_NAMES.has(name)) continue;
    if (value !== null && typeof value === "object") {
      profiles[name] = value as Profile;
    }
  }
  return profiles;
}

export function readConfig(): ConfigFile {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ConfigFile>;
    if (parsed.profiles === undefined) return { ...EMPTY };
    return {
      version: 1,
      current: parsed.current ?? "default",
      profiles: toProfileMap(parsed.profiles),
    };
  } catch {
    // A missing or corrupt file is not an error. It is a first run.
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
  return assertProfileName(
    explicit ?? process.env["OCTRI_PROFILE"] ?? readConfig().current,
  );
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
  assertProfileName(name);
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

const LOOPBACK_HOST =
  /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/i;

/**
 * Rejects plaintext HTTP to anywhere but this machine, since every request
 * carries a session JWT or an API key. `OCTRI_ALLOW_INSECURE_HTTP=1` opts back
 * in for an internal proxy or similar.
 */
function assertTransportSecurity(url: string): void {
  if (!url.startsWith("http://")) return;
  if (process.env["OCTRI_ALLOW_INSECURE_HTTP"] === "1") return;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`"${url}" is not a valid API URL.`);
  }
  if (LOOPBACK_HOST.test(host)) return;
  throw new Error(
    `Refusing to send credentials over plaintext HTTP to ${host}. Use https://, or set OCTRI_ALLOW_INSECURE_HTTP=1 if you accept the risk.`,
  );
}

/** Accepts `local`, a bare host, or a full URL; always returns an /api/v1 root. */
export function normalizeApiUrl(input: string): string {
  if (input === "local" || input === "localhost") return LOCAL_API_URL;
  let url = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  if (!url.endsWith("/api/v1")) url = `${url}/api/v1`;
  assertTransportSecurity(url);
  return url;
}
