/**
 * Progress rendering — bars, sparklines and the gradient "shimmer" used while a
 * remote job reports no percentage at all (the SDK generator reports phases,
 * not completion ratios, for most of a build).
 */

import {
  cursor,
  dim,
  gradient,
  hasUnicode,
  accent,
  green,
  red,
  visibleWidth,
} from "./ansi.js";
import { isStatic, write, line } from "./output.js";

const FULL = hasUnicode ? "█" : "#";
const PARTIALS = hasUnicode ? ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] : [""];
const EMPTY = hasUnicode ? "░" : ".";

export interface BarOptions {
  width?: number;
  /** Paints the filled portion across the brand ramp. */
  brand?: boolean;
  tone?: "accent" | "success" | "danger";
}

/** Renders a determinate bar as a string; callers decide where it goes. */
export function bar(
  ratio: number,
  { width = 24, brand = true, tone = "accent" }: BarOptions = {},
): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const exact = clamped * width;
  const whole = Math.floor(exact);
  const remainder = Math.floor((exact - whole) * PARTIALS.length);

  const filled = FULL.repeat(whole) + (PARTIALS[remainder] ?? "");
  const empty = EMPTY.repeat(Math.max(0, width - visibleWidth(filled)));

  const paint =
    tone === "success"
      ? green
      : tone === "danger"
        ? red
        : brand
          ? (s: string) => gradient(s)
          : accent;

  return `${paint(filled)}${dim(empty)}`;
}

/**
 * Indeterminate bar: a highlight band that travels across the track. `tick`
 * comes from the caller's animation loop so several bars stay in phase.
 */
export function shimmer(tick: number, width = 24): string {
  if (!hasUnicode) return dim("-".repeat(width));
  const head = tick % (width + 8);
  const cells: string[] = [];
  for (let i = 0; i < width; i += 1) {
    const distance = Math.abs(i - (head - 4));
    cells.push(distance < 4 ? FULL : EMPTY);
  }
  const track = cells.join("");
  return gradient(track);
}

/** Sparkline over a numeric series — used for build durations and usage. */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return "";
  const glyphs = hasUnicode
    ? ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
    : ["_", ".", ".", "-", "-", "=", "=", "#"];
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  return values
    .map((v) => {
      const idx = Math.round(((v - min) / span) * (glyphs.length - 1));
      return glyphs[idx] ?? glyphs[0];
    })
    .join("");
}

// ─── Single live bar ──────────────────────────────────────────────────────────

/** A one-line bar that repaints in place until `stop()`. */
export class ProgressBar {
  private tick = 0;
  private timer: NodeJS.Timeout | undefined;
  private ratio: number | undefined;
  private label: string;

  constructor(label: string, private readonly width = 28) {
    this.label = label;
  }

  start(): this {
    if (isStatic()) {
      line(dim(`${this.label}…`));
      return this;
    }
    write(cursor.hide);
    this.render();
    this.timer = setInterval(() => {
      this.tick += 1;
      this.render();
    }, 90);
    this.timer.unref();
    return this;
  }

  /** `ratio` undefined keeps the bar indeterminate. */
  update(label: string, ratio?: number): void {
    this.label = label;
    this.ratio = ratio;
  }

  stop(final?: string): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    if (!isStatic()) {
      write(`${cursor.clearLine}${cursor.toColumn(0)}${cursor.show}`);
    }
    if (final !== undefined) line(final);
  }

  private render(): void {
    const track =
      this.ratio === undefined
        ? shimmer(this.tick, this.width)
        : bar(this.ratio, { width: this.width });
    const pct =
      this.ratio === undefined
        ? ""
        : ` ${dim(`${Math.round(this.ratio * 100)}%`)}`;
    write(
      `${cursor.clearLine}${cursor.toColumn(0)}${track}${pct}  ${this.label}`,
    );
  }
}
