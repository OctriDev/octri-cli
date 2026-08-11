/**
 * Per-invocation context: the resolved settings plus a ready client.
 *
 * Commands receive this instead of touching config or constructing clients
 * themselves, which keeps the global flags (`--profile`, `--api-url`,
 * `--project`, `--token`) working uniformly across every subcommand.
 */

import { flagString, type ParsedArgs } from "./args.js";
import { OctriClient } from "./client.js";
import { resolve, type Resolved } from "./config.js";

export interface Context {
  args: ParsedArgs;
  settings: Resolved;
  client: OctriClient;
  /** Project id from `--project`, the env, or the stored default. */
  projectId(explicit?: string): string;
}

export function createContext(args: ParsedArgs): Context {
  const settings = resolve({
    ...pick("profile", args),
    ...pick("api-url", args, "apiUrl"),
    ...pick("project", args),
    ...pick("token", args),
    ...pick("api-key", args, "apiKey"),
  });

  const client = new OctriClient(settings);

  return {
    args,
    settings,
    client,
    projectId: (explicit?: string) =>
      client.requireProject(explicit ?? flagString(args, "project")),
  };
}

/** Reads a flag into an overrides key only when it was actually supplied. */
function pick(
  flag: string,
  args: ParsedArgs,
  key = flag,
): Record<string, string> {
  const value = flagString(args, flag);
  return value === undefined ? {} : { [key]: value };
}
