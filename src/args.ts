/**
 * Argument parsing.
 *
 * A small POSIX-ish parser: `--flag`, `--flag=value`, `--flag value`, `--no-flag`
 * and single-dash aliases. Values stay strings until a command asks for a type,
 * so a spec version like `1.10` never gets coerced into a number.
 */

export interface ParsedArgs {
  /** Command path, e.g. `["sdk", "build"]`. */
  command: string[];
  /** Everything after the command path that is not a flag. */
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** Arguments after a bare `--`, passed through untouched. */
  rest: string[];
}

/** Flags that take no value — needed to disambiguate `--watch build-id`. */
const BOOLEAN_FLAGS = new Set([
  "help",
  "version",
  "json",
  "quiet",
  "plain",
  "no-color",
  "watch",
  "follow",
  "yes",
  "force",
  "all",
  "extract",
  "open",
  "verbose",
  "dry-run",
  "publish",
  "wait",
  "raw",
  "include-body",
  "diff",
  "stdin",
]);

const ALIASES: Record<string, string> = {
  h: "help",
  v: "version",
  j: "json",
  q: "quiet",
  p: "project",
  l: "lang",
  o: "out",
  w: "watch",
  y: "yes",
  f: "force",
};

/** Number of leading tokens treated as the command path (before positionals). */
export function parse(argv: readonly string[], maxDepth = 2): ParsedArgs {
  const command: string[] = [];
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];

  let i = 0;
  let seenFlag = false;

  while (i < argv.length) {
    const token = argv[i] as string;

    if (token === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      seenFlag = true;
      const body = token.slice(2);
      const eq = body.indexOf("=");

      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        i += 1;
        continue;
      }
      if (body.startsWith("no-") && !BOOLEAN_FLAGS.has(body)) {
        flags[body.slice(3)] = false;
        i += 1;
        continue;
      }

      const next = argv[i + 1];
      if (
        BOOLEAN_FLAGS.has(body) ||
        next === undefined ||
        next.startsWith("-")
      ) {
        flags[body] = true;
        i += 1;
      } else {
        flags[body] = next;
        i += 2;
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      seenFlag = true;
      // Short flags may be clustered (`-qj`); only the last one may take a
      // value, and whether it did decides how many tokens we consume.
      const letters = [...token.slice(1)];
      let tookValue = false;
      letters.forEach((letter, index) => {
        const name = ALIASES[letter] ?? letter;
        const isLast = index === letters.length - 1;
        const next = argv[i + 1];
        if (
          isLast &&
          !BOOLEAN_FLAGS.has(name) &&
          next !== undefined &&
          !next.startsWith("-")
        ) {
          flags[name] = next;
          tookValue = true;
        } else {
          flags[name] = true;
        }
      });
      i += tookValue ? 2 : 1;
      continue;
    }

    // Bare word: part of the command path until a flag or the depth limit.
    if (!seenFlag && command.length < maxDepth && positionals.length === 0) {
      command.push(token);
    } else {
      positionals.push(token);
    }
    i += 1;
  }

  return { command, positionals, flags, rest };
}

// ─── Typed accessors ──────────────────────────────────────────────────────────

export function flagString(
  args: ParsedArgs,
  name: string,
): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function flagNumber(
  args: ParsedArgs,
  name: string,
): number | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Comma- or repeat-separated list, e.g. `--lang go,rust`. */
export function flagList(args: ParsedArgs, name: string): string[] {
  const value = flagString(args, name);
  if (value === undefined) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
