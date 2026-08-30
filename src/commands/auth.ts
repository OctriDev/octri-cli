/**
 * `octri auth …` — sign in, inspect the session, sign out.
 *
 * The API hands the session back only as Set-Cookie headers, so login parses
 * them and stores the access/refresh pair in the profile. Every later request
 * presents the access token as a bearer, which `verifyJwt` accepts.
 */

import { flagString } from "../args.js";
import {
  completeMfa,
  login,
  type LoginResult,
  type MfaChallenge,
} from "../client.js";
import { readConfig, updateProfile } from "../config.js";
import { accent, bold, dim, gray, green } from "../ui/ansi.js";
import { emit, heading, keyValues, line, success, warn } from "../ui/output.js";
import * as prompt from "../ui/prompt.js";
import { withSpinner } from "../ui/spinner.js";

import type * as api from "../api.js";
import type { Context } from "../context.js";

export async function authLogin(ctx: Context): Promise<void> {
  const { settings, args } = ctx;

  const email = flagString(args, "email") ?? (await prompt.text("Email"));
  const password =
    flagString(args, "password") ??
    (await prompt.text("Password", { secret: true }));

  let result = await withSpinner(
    `Signing in to ${dim(settings.apiUrl)}`,
    () => login(settings.apiUrl, email, password),
    { success: () => "Credentials accepted" },
  );

  if (isChallenge(result)) {
    const challenge = result;
    const code =
      flagString(args, "code") ??
      (await prompt.text(
        challenge.hasBackupCodes
          ? "Authenticator code (or a backup code)"
          : "Authenticator code",
      ));
    result = await withSpinner(
      "Verifying second factor",
      () => completeMfa(settings.apiUrl, challenge.challengeToken, code),
      { success: () => "Second factor verified" },
    );
  }

  const session = result;
  updateProfile(
    {
      apiUrl: settings.apiUrl,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      email: session.user.email,
      orgId: session.org.id,
    },
    settings.profile,
  );

  emit(
    {
      profile: settings.profile,
      apiUrl: settings.apiUrl,
      user: session.user,
      org: session.org,
    },
    () => {
      success(
        `Signed in as ${bold(session.user.email)} ${gray("·")} ${accent(session.org.name)} ${dim(`(${session.org.plan})`)}`,
      );
      line(dim(`  profile ${settings.profile} → ${settings.apiUrl}`));
    },
  );
}

export async function authLogout(ctx: Context): Promise<void> {
  // Best-effort server-side revoke; the local tokens are cleared regardless.
  try {
    await ctx.client.request("/auth/logout", { method: "POST", body: {} });
  } catch {
    warn("Server-side logout failed; clearing local credentials anyway.");
  }
  updateProfile(
    {
      accessToken: undefined,
      refreshToken: undefined,
      email: undefined,
      orgId: undefined,
    },
    ctx.settings.profile,
  );
  emit({ ok: true }, () => success("Signed out."));
}

export async function authWhoami(ctx: Context): Promise<void> {
  const identity = await ctx.client.request<
    api.Me & { role?: string; permissions?: unknown }
  >("/auth/me");

  emit(
    { profile: ctx.settings.profile, apiUrl: ctx.settings.apiUrl, ...identity },
    () => {
      heading("Session");
      keyValues([
        [
          "user",
          `${identity.user.name ?? ""} ${dim(`<${identity.user.email}>`)}`.trim(),
        ],
        ["org", `${identity.org.name} ${dim(`(${identity.org.plan})`)}`],
        ["role", identity.role ?? dim("—")],
        ["profile", ctx.settings.profile],
        ["api", ctx.settings.apiUrl],
        [
          "project",
          ctx.settings.defaultProject ??
            dim("none — run `octri projects use <id>`"),
        ],
      ]);
    },
  );
}

/** Prints the bearer token — handy for `curl -H "Authorization: Bearer $(octri auth token)"`. */
export function authToken(ctx: Context): void {
  const token = ctx.settings.accessToken;
  if (token === undefined) {
    throw new Error("No stored token. Run `octri auth login` first.");
  }
  // Deliberately bare: this output is meant to be captured by a shell.
  process.stdout.write(`${token}\n`);
}

/** `octri auth profiles` — what is configured on this machine. */
export function authProfiles(): void {
  const config = readConfig();
  const rows = Object.entries(config.profiles).map(([name, profile]) => ({
    name,
    current: name === config.current,
    apiUrl: profile.apiUrl,
    email: profile.email,
    project: profile.defaultProject,
    authenticated:
      profile.accessToken !== undefined || profile.apiKey !== undefined,
  }));

  emit({ current: config.current, profiles: rows }, () => {
    heading("Profiles");
    for (const row of rows) {
      const marker = row.current ? green("●") : dim("○");
      line(
        `  ${marker} ${bold(row.name)} ${dim(row.apiUrl)}${
          row.email === undefined ? "" : ` ${gray("·")} ${row.email}`
        }${row.authenticated ? "" : dim("  (signed out)")}`,
      );
    }
  });
}

function isChallenge(value: LoginResult | MfaChallenge): value is MfaChallenge {
  return (value as MfaChallenge).mfaRequired === true;
}
