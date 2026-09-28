import { describe, expect, it } from 'vitest';
import { GRID_GAP, OVERSCAN_ROWS, cardWidthFor, columnsFor, rowWindow } from './gridLayout';

const ROW_HEIGHT = 100;

describe('columnsFor', () => {
  it('never drops below one column, however narrow the grid is', () => {
    expect(columnsFor(0)).toBe(1);
    expect(columnsFor(120)).toBe(1);
  });

  it('adds a column once the extra card and its gap both fit', () => {
    expect(columnsFor(499)).toBe(1);
    expect(columnsFor(500)).toBe(2);
  });

  it('stops at six columns on an ultrawide window', () => {
    expect(columnsFor(4000)).toBe(6);
  });
});

describe('cardWidthFor', () => {
  it('takes the gaps between the columns out of the available width', () => {
    expect(cardWidthFor(800, 3)).toBe((800 - 2 * GRID_GAP) / 3);
  });

  it('gives a single column the whole width, with no trailing gap', () => {
    expect(cardWidthFor(300, 1)).toBe(300);
  });
});

describe('rowWindow', () => {
  const window = (relativeTop: number, rowCount = 100) =>
    rowWindow({ relativeTop, viewportHeight: 500, rowHeight: ROW_HEIGHT, rowCount });

  it('mounts the visible rows plus the overscan on both sides', () => {
    expect(window(1000)).toEqual({ startRow: 10 - OVERSCAN_ROWS, endRow: 15 + OVERSCAN_ROWS });
  });

  it('clamps to the first row while the grid sits below the fold', () => {
    expect(window(-400).startRow).toBe(0);
  });

  it('clamps to the last row at the bottom of the list', () => {
    expect(window(9600, 100).endRow).toBe(99);
  });

  it('leaves nothing to mount for an empty list', () => {
    const { startRow, endRow } = window(0, 0);
    expect(endRow).toBeLessThan(startRow);
  });
});
