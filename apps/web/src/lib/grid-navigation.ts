/** A cell position in a seat grid of rows × columns. */
export interface GridPosition {
  row: number;
  col: number;
}

export interface GridKey {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/**
 * Roving-focus movement for the seat grid, following the WAI-ARIA grid pattern: arrows move one
 * cell and stop at the edges, Home/End go to the ends of the row, Ctrl+Home/End to the first and
 * last seat, PageUp/PageDown to the front and back rows. Returns null for keys the grid ignores.
 * `rowLengths[r]` is the number of seats in row r, so ragged rows still clamp correctly.
 */
export function nextGridPosition(
  from: GridPosition,
  { key, ctrlKey = false, metaKey = false }: GridKey,
  rowLengths: readonly number[],
): GridPosition | null {
  const lastRow = rowLengths.length - 1;
  if (lastRow < 0) return null;
  const clampCol = (row: number, col: number) => Math.max(0, Math.min(col, (rowLengths[row] ?? 1) - 1));
  const jump = ctrlKey || metaKey;

  switch (key) {
    case "ArrowLeft":
      return { row: from.row, col: Math.max(0, from.col - 1) };
    case "ArrowRight":
      return { row: from.row, col: clampCol(from.row, from.col + 1) };
    case "ArrowUp": {
      const row = Math.max(0, from.row - 1);
      return { row, col: clampCol(row, from.col) };
    }
    case "ArrowDown": {
      const row = Math.min(lastRow, from.row + 1);
      return { row, col: clampCol(row, from.col) };
    }
    case "Home":
      return jump ? { row: 0, col: 0 } : { row: from.row, col: 0 };
    case "End":
      return jump ? { row: lastRow, col: clampCol(lastRow, Infinity) } : { row: from.row, col: clampCol(from.row, Infinity) };
    case "PageUp":
      return { row: 0, col: clampCol(0, from.col) };
    case "PageDown":
      return { row: lastRow, col: clampCol(lastRow, from.col) };
    default:
      return null;
  }
}
