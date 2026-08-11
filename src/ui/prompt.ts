/**
 * Interactive prompts (raw-mode, zero dependency).
 *
 * Every prompt refuses to run without a TTY: a non-interactive caller must pass
 * the value as a flag instead, so scripts and the MCP server can never hang
 * waiting on stdin.
 */

import { accent, cursor, dim, gray, green, bold } from "./ansi.js";
import { symbols, write, line } from "./output.js";

export class NonInteractiveError extends Error {
  constructor(what: string) {
    super(
      `${what} is required. This shell is not interactive — pass it as a flag instead.`,
    );
    this.name = "NonInteractiveError";
  }
}

function assertInteractive(what: string): void {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new NonInteractiveError(what);
  }
}

/** Reads keypresses until `handler` resolves the prompt. */
function readKeys(
  onKey: (key: string, done: (value?: unknown) => void) => void,
): Promise<unknown> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", listener);
    };

    const listener = (key: string): void => {
      // Ctrl-C / Ctrl-D abort the whole command, not just the prompt.
      if (key === "\u0003" || key === "\u0004") {
        cleanup();
        write(cursor.show);
        process.exit(130);
      }
      onKey(key, (value) => {
        cleanup();
        resolve(value);
      });
    };

    stdin.on("data", listener);
  });
}

// ─── Select ───────────────────────────────────────────────────────────────────

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

/** Arrow-key list picker. Returns the chosen value. */
export async function select<T>(
  message: string,
  choices: readonly Choice<T>[],
): Promise<T> {
  assertInteractive(message);
  if (choices.length === 0) throw new Error(`${message}: nothing to choose.`);

  let index = 0;
  let painted = 0;

  const render = (): void => {
    const lines = [`${accent("?")} ${bold(message)}`];
    for (const [i, choice] of choices.entries()) {
      const active = i === index;
      const pointer = active ? accent(symbols.pointer) : " ";
      const label = active ? accent(choice.label) : choice.label;
      const hint = choice.hint === undefined ? "" : dim(`  ${choice.hint}`);
      lines.push(`${pointer} ${label}${hint}`);
    }
    const rewind = painted === 0 ? "" : cursor.up(painted) + cursor.toColumn(0);
    write(`${rewind}${cursor.clearDown}${lines.map((l) => `${l}\n`).join("")}`);
    painted = lines.length;
  };

  write(cursor.hide);
  render();

  await readKeys((key, done) => {
    if (key === "\u001b[A" || key === "k") {
      index = (index - 1 + choices.length) % choices.length;
      render();
    } else if (key === "\u001b[B" || key === "j") {
      index = (index + 1) % choices.length;
      render();
    } else if (key === "\r" || key === "\n") {
      done();
    }
  });

  // Collapse the list back to a single answered line.
  write(`${cursor.up(painted)}${cursor.toColumn(0)}${cursor.clearDown}`);
  const chosen = choices[index] as Choice<T>;
  line(`${green(symbols.ok)} ${bold(message)} ${gray(symbols.arrow)} ${chosen.label}`);
  write(cursor.show);
  return chosen.value;
}

// ─── Text ─────────────────────────────────────────────────────────────────────

export interface TextOptions {
  /** Masks input — used for the login password. */
  secret?: boolean;
  defaultValue?: string;
}

export async function text(
  message: string,
  { secret = false, defaultValue }: TextOptions = {},
): Promise<string> {
  assertInteractive(message);
  let value = "";

  const render = (): void => {
    const shown = secret ? "•".repeat(value.length) : value;
    const placeholder =
      value.length === 0 && defaultValue !== undefined
        ? dim(defaultValue)
        : shown;
    write(
      `${cursor.clearLine}${cursor.toColumn(0)}${accent("?")} ${bold(message)} ${placeholder}`,
    );
  };

  render();

  await readKeys((key, done) => {
    if (key === "\r" || key === "\n") {
      done();
      return;
    }
    if (key === "\u007f" || key === "\b") {
      value = value.slice(0, -1);
      render();
      return;
    }
    // Ignore control/escape sequences; only take printable input.
    if (key.charCodeAt(0) < 32) return;
    value += key;
    render();
  });

  const answer = value.length > 0 ? value : (defaultValue ?? "");
  write(`${cursor.clearLine}${cursor.toColumn(0)}`);
  line(
    `${green(symbols.ok)} ${bold(message)} ${gray(symbols.arrow)} ${secret ? dim("(hidden)") : answer}`,
  );
  return answer;
}

// ─── Confirm ──────────────────────────────────────────────────────────────────

export async function confirm(
  message: string,
  defaultValue = false,
): Promise<boolean> {
  assertInteractive(message);
  const hint = defaultValue ? "Y/n" : "y/N";
  write(`${accent("?")} ${bold(message)} ${dim(`(${hint})`)} `);

  let answer = defaultValue;
  await readKeys((key, done) => {
    if (key === "y" || key === "Y") {
      answer = true;
      done();
    } else if (key === "n" || key === "N") {
      answer = false;
      done();
    } else if (key === "\r" || key === "\n") {
      done();
    }
  });

  write(`${cursor.clearLine}${cursor.toColumn(0)}`);
  line(
    `${green(symbols.ok)} ${bold(message)} ${gray(symbols.arrow)} ${answer ? "yes" : "no"}`,
  );
  return answer;
}
