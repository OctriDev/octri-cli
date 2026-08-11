/**
 * Table rendering.
 *
 * Columns size themselves to their content, then the widest flexible column is
 * squeezed until the whole row fits the terminal — so an id column stays intact
 * while a long description is the thing that gets an ellipsis.
 */

import {
  dim,
  gray,
  hasUnicode,
  pad,
  terminalWidth,
  truncate,
  visibleWidth,
} from "./ansi.js";
import { line } from "./output.js";

export interface Column<T> {
  header: string;
  /** Cell text, already coloured if the caller wants colour. */
  value: (row: T) => string;
  align?: "left" | "right" | "center";
  /** Columns with a lower weight are squeezed first when the row overflows. */
  flex?: number;
  minWidth?: number;
}

const CHARS = hasUnicode
  ? { h: "─", v: "│", tl: "╭", tr: "╮", bl: "╰", br: "╯", cross: "┼", tDown: "┬", tUp: "┴", tRight: "├", tLeft: "┤" }
  : { h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+", cross: "+", tDown: "+", tUp: "+", tRight: "+", tLeft: "+" };

export interface TableOptions {
  /** `borders` draws a full box; `plain` prints a dimmed header rule only. */
  style?: "plain" | "borders";
  emptyMessage?: string;
}

export function table<T>(
  rows: readonly T[],
  columns: readonly Column<T>[],
  options: TableOptions = {},
): void {
  const { style = "plain", emptyMessage = "Nothing to show." } = options;

  if (rows.length === 0) {
    line(dim(`  ${emptyMessage}`));
    return;
  }

  const cells = rows.map((row) => columns.map((col) => col.value(row)));
  const widths = columns.map((col, i) =>
    Math.max(
      visibleWidth(col.header),
      col.minWidth ?? 0,
      ...cells.map((r) => visibleWidth(r[i] ?? "")),
    ),
  );

  // Squeeze to fit: repeatedly shave the lowest-weight column that is still
  // wider than its minimum, rather than truncating every column equally.
  const gutter = style === "borders" ? 3 : 2;
  const chrome = style === "borders" ? 4 : 2;
  const budget = terminalWidth() - chrome;
  let total = widths.reduce((a, b) => a + b, 0) + gutter * (widths.length - 1);

  while (total > budget) {
    let target = -1;
    let worstFlex = Infinity;
    for (let i = 0; i < columns.length; i += 1) {
      const col = columns[i] as Column<T>;
      const min = col.minWidth ?? 6;
      const flex = col.flex ?? 1;
      if ((widths[i] ?? 0) > min && flex <= worstFlex) {
        worstFlex = flex;
        target = i;
      }
    }
    if (target === -1) break;
    widths[target] = (widths[target] ?? 0) - 1;
    total -= 1;
  }

  const renderRow = (values: readonly string[], head = false): string => {
    const painted = values.map((value, i) => {
      const width = widths[i] ?? 0;
      const col = columns[i] as Column<T>;
      return pad(truncate(value, width), width, col.align ?? "left");
    });
    if (style === "borders") {
      return `${CHARS.v} ${painted.join(` ${CHARS.v} `)} ${CHARS.v}`;
    }
    return `  ${painted.join("  ")}${head ? "" : ""}`;
  };

  const rule = (left: string, mid: string, right: string): string =>
    `${left}${widths.map((w) => CHARS.h.repeat(w + 2)).join(mid)}${right}`;

  if (style === "borders") {
    line(dim(rule(CHARS.tl, CHARS.tDown, CHARS.tr)));
    line(renderRow(columns.map((c) => gray(c.header)), true));
    line(dim(rule(CHARS.tRight, CHARS.cross, CHARS.tLeft)));
    for (const row of cells) line(renderRow(row));
    line(dim(rule(CHARS.bl, CHARS.tUp, CHARS.br)));
    return;
  }

  line(renderRow(columns.map((c) => gray(c.header.toUpperCase())), true));
  line(dim(`  ${widths.map((w) => CHARS.h.repeat(w)).join("  ")}`));
  for (const row of cells) line(renderRow(row));
}
