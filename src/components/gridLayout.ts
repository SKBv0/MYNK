/** Pure geometry of the windowed card grid: how many columns fit and which rows to mount. */

export const GRID_GAP = 20;
export const OVERSCAN_ROWS = 2;
const MIN_CARD_WIDTH = 240;
const MAX_COLUMNS = 6;

/** Column count from the grid's own width, so a docked inspector is accounted for. */
export const columnsFor = (width: number): number =>
  Math.max(1, Math.min(MAX_COLUMNS, Math.floor((width + GRID_GAP) / (MIN_CARD_WIDTH + GRID_GAP))));

export const cardWidthFor = (width: number, columns: number): number =>
  columns <= 1 ? width : (width - GRID_GAP * (columns - 1)) / columns;

export interface RowWindow {
  startRow: number;
  endRow: number;
}

/**
 * Rows to mount for a scroll position, padded by `OVERSCAN_ROWS` on both sides.
 * `endRow` is inclusive and below `startRow` when there is nothing to show.
 */
export const rowWindow = (input: {
  /** Scroll position relative to the top of the grid; negative while the grid is below the fold. */
  relativeTop: number;
  viewportHeight: number;
  rowHeight: number;
  rowCount: number;
}): RowWindow => ({
  startRow: Math.max(0, Math.floor(input.relativeTop / input.rowHeight) - OVERSCAN_ROWS),
  endRow: Math.min(
    input.rowCount - 1,
    Math.ceil((input.relativeTop + input.viewportHeight) / input.rowHeight) + OVERSCAN_ROWS,
  ),
});
