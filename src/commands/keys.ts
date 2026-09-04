/**
 * `octri keys …` — the org's API keys, the credential a CI job or a service
 * uses instead of a human session.
 *
 * The plaintext key exists in exactly one response, on creation. It is printed
 * once here and never stored, which is why `keys create` is loud about it.
 */

import * as api from "../api.js";
import { flagBool, flagString } from "../args.js";
import { bold, dim, red, yellow } from "../ui/ansi.js";
import { panel } from "../ui/box.js";
import {
  emit,
  heading,
  line,
  note,
  relativeTime,
  success,
  warn,
} from "../ui/output.js";
import { withSpinner } from "../ui/spinner.js";
import { table } from "../ui/table.js";

import type { Context } from "../context.js";

export async function keysList(ctx: Context): Promise<void> {
  const keys = await withSpinner("Loading API keys", () =>
    api.listApiKeys(ctx.client),
  );

  emit(keys, () => {
    heading(`API keys ${dim(`(${keys.length})`)}`);
    table(
      keys,
      [
        { header: "name", value: (k) => bold(k.name), flex: 2, minWidth: 16 },
        { header: "prefix", value: (k) => dim(k.prefix ?? "—"), flex: 5 },
        { header: "last used", value: (k) => relativeTime(k.lastUsedAt), flex: 5 },
        { header: "expires", value: (k) => expiry(k.expiresAt), flex: 5 },
        { header: "created by", value: (k) => dim(k.createdBy ?? "—"), flex: 5 },
        { header: "id", value: (k) => dim(k.id), flex: 7, minWidth: 24 },
      ],
      { emptyMessage: "No API keys — `octri keys create <name>`." },
    );
  });
}

/** An expiry in the past is the thing worth seeing at a glance. */
function expiry(iso: string | undefined): string {
  if (iso === undefined) return dim("never");
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return dim(iso);
  return at < Date.now() ? red("expired") : relativeTime(iso);
}

export async function keysCreate(ctx: Context): Promise<void> {
  const name = ctx.args.positionals[0] ?? flagString(ctx.args, "name");
  if (name === undefined) {
    throw new Error("Usage: octri keys create <name> [--expires 2027-01-01]");
  }

  // Accept a plain date as well as a full timestamp — the API wants ISO 8601.
  const expires = flagString(ctx.args, "expires");
  const expiresAt =
    expires === undefined
      ? undefined
      : new Date(/T/.test(expires) ? expires : `${expires}T00:00:00.000Z`).toISOString();

  const result = await withSpinner(`Creating ${bold(name)}`, () =>
    api.createApiKey(ctx.client, name, expiresAt),
  );

  emit(result, () => {
    success(`Created ${bold(result.key.name)} ${dim(result.key.id)}`);
    line();
    panel([result.plaintext], { title: "Your API key" });
    warn("This is the only time the key is shown. Store it now.");
    note("Use it with: octri --api-key <key>, or set it in the profile.");
  });
}

export async function keysRevoke(ctx: Context): Promise<void> {
  const keyId = ctx.args.positionals[0];
  if (keyId === undefined) throw new Error("Usage: octri keys revoke <keyId>");

  if (!flagBool(ctx.args, "yes")) {
    warn(
      `Revoking ${yellow(keyId)} breaks anything still using it. Re-run with --yes to confirm.`,
    );
    return;
  }

  await withSpinner("Revoking key", () => api.revokeApiKey(ctx.client, keyId));
  emit({ revoked: keyId }, () => success("Key revoked."));
}
