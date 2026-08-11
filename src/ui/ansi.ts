/**
 * ANSI primitives.
 *
 * Hand-rolled rather than pulled from chalk/picocolors so the CLI ships with a
 * single runtime dependency (the MCP SDK). Colour depth is probed once at
 * import time and every helper degrades to a plain passthrough when the stream
 * is not a terminal, so piping to a file or into `jq` yields clean text.
 */

// ─── Capability probe ─────────────────────────────────────────────────────────

/** 0 = none, 1 = 16 colours, 2 = 256 colours, 3 = truecolor. */
function probeColorDepth(): 0 | 1 | 2 | 3 {
  const env = process.env;
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return 0;

  const forced = env["FORCE_COLOR"];
  if (forced !== undefined) {
    if (forced === "0" || forced === "false") return 0;
    if (forced === "1" || forced === "true") return 1;
    if (forced === "2") return 2;
    return 3;
  }

  if (process.stdout.isTTY !== true) return 0;
  if (env["TERM"] === "dumb") return 0;

  const colorterm = env["COLORTERM"] ?? "";
  if (colorterm === "truecolor" || colorterm === "24bit") return 3;
  if (env["TERM_PROGRAM"] === "iTerm.app" || env["TERM_PROGRAM"] === "vscode") {
    return 3;
  }
  if ((env["TERM"] ?? "").includes("256")) return 2;
  return 1;
}

export const colorDepth = probeColorDepth();
export const hasColor = colorDepth > 0;

/**
 * Unicode is assumed unless the terminal is clearly a legacy Windows console.
 * Controls box-drawing vs ASCII fallbacks throughout the UI layer.
 */
export const hasUnicode =
  process.platform !== "win32" ||
  process.env["WT_SESSION"] !== undefined ||
  process.env["TERM_PROGRAM"] === "vscode";

// ─── Core wrapping ────────────────────────────────────────────────────────────

const ESC = "\u001b[";

type Wrap = (input: string) => string;

function sgr(open: number, close: number): Wrap {
  if (!hasColor) return (s) => s;
  const openSeq = `${ESC}${open}m`;
  const closeSeq = `${ESC}${close}m`;
  return (s) => `${openSeq}${s.replaceAll(closeSeq, openSeq)}${closeSeq}`;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

export const bold = sgr(1, 22);
export const dim = sgr(2, 22);
export const italic = sgr(3, 23);
export const underline = sgr(4, 24);
export const inverse = sgr(7, 27);
export const strike = sgr(9, 29);

export const black = sgr(30, 39);
export const red = sgr(31, 39);
export const green = sgr(32, 39);
export const yellow = sgr(33, 39);
export const blue = sgr(34, 39);
export const magenta = sgr(35, 39);
export const cyan = sgr(36, 39);
export const white = sgr(37, 39);
export const gray = sgr(90, 39);

export const bgRed = sgr(41, 49);
export const bgGreen = sgr(42, 49);
export const bgYellow = sgr(43, 49);
export const bgBlue = sgr(44, 49);
export const bgCyan = sgr(46, 49);

// ─── Truecolor / 256 ──────────────────────────────────────────────────────────

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** Nearest xterm-256 index for an RGB triple (6×6×6 cube + grey ramp). */
function rgbTo256({ r, g, b }: Rgb): number {
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v: number): number => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** Foreground colour from an RGB triple, degraded to the terminal's depth. */
export function fg(rgb: Rgb): Wrap {
  if (colorDepth === 0) return (s) => s;
  if (colorDepth === 3) {
    return (s) => `${ESC}38;2;${rgb.r};${rgb.g};${rgb.b}m${s}${ESC}39m`;
  }
  if (colorDepth === 2) {
    return (s) => `${ESC}38;5;${rgbTo256(rgb)}m${s}${ESC}39m`;
  }
  // 16-colour terminals: pick the dominant channel.
  const { r, g, b } = rgb;
  if (r > g && r > b) return red;
  if (g > r && g > b) return green;
  if (b > r && b > g) return blue;
  return white;
}

export function hex(value: string): Wrap {
  return fg(hexToRgb(value));
}

// ─── Brand palette ────────────────────────────────────────────────────────────

/** Octri's accent ramp — used for banners, gradients and progress fills. */
export const BRAND: readonly string[] = [
  "#7c5cff",
  "#8f5bff",
  "#a55bf5",
  "#c05ce0",
  "#e05fbb",
];

export const accent = hex("#8f5bff");
export const accentSoft = hex("#b39dff");

/** Paints a string across the brand ramp, one interpolated step per character. */
export function gradient(
  text: string,
  stops: readonly string[] = BRAND,
): string {
  if (!hasColor || stops.length < 2) return text;
  const rgbStops = stops.map(hexToRgb);
  const chars = [...text];
  const span = chars.length - 1 || 1;

  return chars
    .map((char, i) => {
      if (char === " ") return char;
      const t = (i / span) * (rgbStops.length - 1);
      const lo = Math.min(Math.floor(t), rgbStops.length - 2);
      const frac = t - lo;
      const a = rgbStops[lo] as Rgb;
      const b = rgbStops[lo + 1] as Rgb;
      return fg({
        r: Math.round(a.r + (b.r - a.r) * frac),
        g: Math.round(a.g + (b.g - a.g) * frac),
        b: Math.round(a.b + (b.b - a.b) * frac),
      })(char);
    })
    .join("");
}

// ─── Measurement / slicing ────────────────────────────────────────────────────

const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** Length of `text` with escape sequences discounted. */
export function visibleWidth(text: string): number {
  return [...text.replace(ANSI_RE, "")].length;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Pads to `width` without counting escape sequences toward the length. */
export function pad(
  text: string,
  width: number,
  align: "left" | "right" | "center" = "left",
): string {
  const gapSize = Math.max(0, width - visibleWidth(text));
  if (gapSize === 0) return text;
  if (align === "right") return " ".repeat(gapSize) + text;
  if (align === "center") {
    const left = Math.floor(gapSize / 2);
    return " ".repeat(left) + text + " ".repeat(gapSize - left);
  }
  return text + " ".repeat(gapSize);
}

/** Truncates to `width` visible characters, appending an ellipsis when cut. */
export function truncate(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return "…";
  const plain = stripAnsi(text);
  return `${[...plain].slice(0, width - 1).join("")}…`;
}

// ─── Cursor / screen control ──────────────────────────────────────────────────

/**
 * Cursor control is meaningless off a terminal and would leak raw escapes into
 * a pipe or a log file, so every sequence collapses to "" when stdout is not a
 * TTY. Callers can then emit them unconditionally.
 */
const interactive = process.stdout.isTTY === true;
const seq = (value: string): string => (interactive ? value : "");

export const cursor = {
  hide: seq(`${ESC}?25l`),
  show: seq(`${ESC}?25h`),
  up: (n = 1) => seq(`${ESC}${n}A`),
  down: (n = 1) => seq(`${ESC}${n}B`),
  toColumn: (n = 0) => seq(`${ESC}${n + 1}G`),
  clearLine: seq(`${ESC}2K`),
  clearDown: seq(`${ESC}0J`),
} as const;

/** Terminal width, clamped to something sane for pipes and CI. */
export function terminalWidth(): number {
  const cols = process.stdout.columns;
  if (typeof cols !== "number" || Number.isNaN(cols)) return 100;
  return Math.max(40, Math.min(cols, 160));
}
