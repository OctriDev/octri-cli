/**
 * Animated spinners.
 *
 * `Spinner` drives a single status line; `TaskList` drives an N-line block that
 * repaints in place (used by the multi-language build view). Both degrade to
 * plain, append-only logging whenever `isStatic()` is true, so CI logs and
 * `--json` runs stay readable.
 */

import { cursor, dim, green, red, yellow, accent, gradient } from "./ansi.js";
import { isStatic, symbols, write, line } from "./output.js";

// ─── Frame sets ───────────────────────────────────────────────────────────────

export const FRAMES = {
  /** Default — braille dots, the most legible at small sizes. */
  dots: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  /** Used while the generator is working — reads as "something is compiling". */
  pulse: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃", "▂"],
  /** Long-running remote work — a travelling highlight. */
  bounce: ["⠈", "⠐", "⠠", "⢀", "⡀", "⠄", "⠂", "⠁"],
  arc: ["◜", "◠", "◝", "◞", "◡", "◟"],
  ascii: ["-", "\\", "|", "/"],
} as const;

export type FrameSet = keyof typeof FRAMES;

const INTERVAL_MS = 80;

// ─── Single-line spinner ──────────────────────────────────────────────────────

export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private text: string;
  private readonly frames: readonly string[];
  private readonly startedAt = Date.now();
  private active = false;

  constructor(text: string, frames: FrameSet = "dots") {
    this.text = text;
    this.frames = FRAMES[frames];
  }

  start(): this {
    // Without animation the start line would just duplicate the settle line, so
    // non-TTY output carries only the outcome.
    if (isStatic()) return this;
    this.active = true;
    write(cursor.hide);
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % this.frames.length;
      this.render();
    }, INTERVAL_MS);
    this.timer.unref();
    return this;
  }

  /** Swaps the label without interrupting the animation. */
  update(text: string): this {
    this.text = text;
    if (!this.active && isStatic()) line(`${dim(symbols.arrow)} ${text}`);
    return this;
  }

  succeed(text?: string): void {
    this.stop(`${green(symbols.ok)} ${text ?? this.text}`);
  }

  failWith(text?: string): void {
    this.stop(`${red(symbols.fail)} ${text ?? this.text}`);
  }

  warnWith(text?: string): void {
    this.stop(`${yellow(symbols.warn)} ${text ?? this.text}`);
  }

  /** Stops the animation, optionally leaving a final line in its place. */
  stop(finalLine?: string): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.active) {
      write(`${cursor.clearLine}${cursor.toColumn(0)}${cursor.show}`);
      this.active = false;
    }
    if (finalLine !== undefined) line(finalLine);
  }

  /** Milliseconds since `new Spinner(...)`, for "done in 4.2s" messages. */
  elapsed(): number {
    return Date.now() - this.startedAt;
  }

  private render(): void {
    const frame = this.frames[this.frame] ?? "";
    write(
      `${cursor.clearLine}${cursor.toColumn(0)}${accent(frame)} ${this.text}`,
    );
  }
}

/** Runs `work` under a spinner, settling it from the outcome. */
export async function withSpinner<T>(
  text: string,
  work: (spinner: Spinner) => Promise<T>,
  options: { success?: (value: T) => string; frames?: FrameSet } = {},
): Promise<T> {
  const spinner = new Spinner(text, options.frames ?? "dots").start();
  try {
    const value = await work(spinner);
    spinner.succeed(options.success?.(value));
    return value;
  } catch (err) {
    spinner.failWith(`${text} ${dim("failed")}`);
    throw err;
  }
}

// ─── Multi-line task list ─────────────────────────────────────────────────────

export type TaskState =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "warn"
  | "skipped";

export interface TaskRow {
  id: string;
  label: string;
  state: TaskState;
  /** Right-hand detail column — phase names, timings, error summaries. */
  detail?: string | undefined;
}

/**
 * An in-place repainting block of rows. Each `set()` mutates a row and the next
 * animation tick redraws the whole block, so ordering stays stable no matter
 * which language finishes first.
 */
export class TaskList {
  private readonly rows: TaskRow[] = [];
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private painted = 0;
  private readonly title: string | undefined;

  constructor(rows: readonly TaskRow[], title?: string) {
    this.rows = rows.map((r) => ({ ...r }));
    this.title = title;
  }

  start(): this {
    if (isStatic()) return this;
    write(cursor.hide);
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.dots.length;
      this.render();
    }, INTERVAL_MS);
    this.timer.unref();
    return this;
  }

  /** Updates a row by id. Unknown ids are ignored (the build may add lanes). */
  set(id: string, patch: Partial<Omit<TaskRow, "id">>): void {
    const row = this.rows.find((r) => r.id === id);
    if (row === undefined) return;
    const changed =
      row.state !== (patch.state ?? row.state) ||
      row.detail !== (patch.detail ?? row.detail);
    Object.assign(row, patch);
    // In static mode every transition is a fresh line, so only log real changes.
    if (isStatic() && changed && patch.state !== undefined) {
      line(`${stateGlyph(patch.state, 0)} ${row.label} ${dim(row.detail ?? "")}`);
    }
  }

  add(row: TaskRow): void {
    if (this.rows.some((r) => r.id === row.id)) return;
    this.rows.push({ ...row });
  }

  snapshot(): readonly TaskRow[] {
    return this.rows.map((r) => ({ ...r }));
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (isStatic()) return;
    // One last paint so the block shows its terminal states, then hand the
    // cursor back. The block itself stays on screen.
    this.render();
    write(cursor.show);
  }

  private render(): void {
    if (isStatic()) return;
    const lines: string[] = [];
    if (this.title !== undefined) lines.push(gradient(this.title));
    for (const row of this.rows) {
      const glyph = stateGlyph(row.state, this.frame);
      const detail = row.detail === undefined ? "" : ` ${dim(row.detail)}`;
      lines.push(`  ${glyph} ${row.label}${detail}`);
    }

    // Rewind over the previously painted block, then repaint it wholesale. Each
    // line is newline-terminated, so the cursor always parks on the line right
    // after the block and `painted` is exactly how far up the next rewind goes.
    const rewind =
      this.painted === 0
        ? ""
        : `${cursor.up(this.painted)}${cursor.toColumn(0)}`;
    write(
      `${rewind}${cursor.clearDown}${lines.map((l) => `${l}\n`).join("")}`,
    );
    this.painted = lines.length;
  }
}

function stateGlyph(state: TaskState, frame: number): string {
  switch (state) {
    case "running":
      return accent(FRAMES.dots[frame % FRAMES.dots.length] ?? symbols.running);
    case "done":
      return green(symbols.ok);
    case "failed":
      return red(symbols.fail);
    case "warn":
      return yellow(symbols.warn);
    case "skipped":
      return dim(symbols.bullet);
    default:
      return dim(symbols.queued);
  }
}
