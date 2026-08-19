/**
 * Responsive viewport layout for the dashboard.
 *
 * {@link chooseLayout} is the single pure decision function: the same
 * `{columns, rows}` input always yields the same layout, so every threshold
 * is unit-testable without a terminal. {@link useViewport} is the only
 * impure wrapper, translating Ink's live window size through it.
 */

import { useWindowSize } from "ink";

/** Minimum columns for the two-column wide layout (two cards plus gutters). */
export const WIDE_MIN_COLUMNS = 100;

/** Maximum rows before the layout collapses to the compact short form. */
export const SHORT_MAX_ROWS = 20;

/** Fallbacks when the terminal size is unknown (non-TTY, tests, CI). */
export const DEFAULT_COLUMNS = 80;
export const DEFAULT_ROWS = 24;

export type LayoutKind = "wide" | "narrow" | "short";

/** Terminal size as reported by Ink's `useWindowSize`. */
export interface ViewportSize {
  readonly columns: number;
  readonly rows: number;
}

export interface ViewportLayout {
  readonly kind: LayoutKind;
  /** Dashboard card columns: two when wide, one otherwise. */
  readonly columns: 1 | 2;
  /** Hide decoration (key hints, spacers) to preserve rows. */
  readonly compact: boolean;
  readonly width: number;
  readonly height: number;
}

function normalizedSize(size: ViewportSize): {
  width: number;
  height: number;
} {
  const width =
    Number.isFinite(size.columns) && size.columns > 0
      ? Math.floor(size.columns)
      : DEFAULT_COLUMNS;
  const height =
    Number.isFinite(size.rows) && size.rows > 0
      ? Math.floor(size.rows)
      : DEFAULT_ROWS;
  return { width, height };
}

/**
 * Chooses the layout for a terminal size.
 *
 * - `short`: at most {@link SHORT_MAX_ROWS} rows. The row budget dominates
 *   the column count, so cards stack in one column and decoration hides.
 * - `wide`: at least {@link WIDE_MIN_COLUMNS} columns. Cards flow in two
 *   columns; the full footer and hints render.
 * - `narrow`: everything else — one column, full decoration.
 *
 * Non-positive or non-finite sizes fall back to {@link DEFAULT_COLUMNS} x
 * {@link DEFAULT_ROWS}, which yields `narrow`; this keeps non-TTY pipes and
 * test renders deterministic.
 */
export function chooseLayout(size: ViewportSize): ViewportLayout {
  const { width, height } = normalizedSize(size);

  if (height <= SHORT_MAX_ROWS) {
    return { kind: "short", columns: 1, compact: true, width, height };
  }
  if (width >= WIDE_MIN_COLUMNS) {
    return { kind: "wide", columns: 2, compact: false, width, height };
  }
  return { kind: "narrow", columns: 1, compact: false, width, height };
}

/** Live viewport bound to Ink's window size; re-renders on terminal resize. */
export function useViewport(): ViewportLayout {
  const { columns, rows } = useWindowSize();
  return chooseLayout({ columns, rows });
}
