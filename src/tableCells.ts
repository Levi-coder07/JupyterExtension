/** Stable DOM cell addresses and content used to detect stale table links. */
export interface TableCellSnapshot {
  id: string;
  text: string;
  rowSpan: number;
  colSpan: number;
  header: boolean;
}

/** Preserve physical cell order and spans instead of assuming a rectangular grid. */
export function captureTableCells(
  table: HTMLTableElement
): TableCellSnapshot[] {
  return Array.from(table.rows).flatMap((row, rowIndex) =>
    Array.from(row.cells).map((cell, cellIndex) => ({
      id: `r${rowIndex}c${cellIndex}`,
      text: cell.textContent?.trim() ?? '',
      rowSpan: cell.rowSpan,
      colSpan: cell.colSpan,
      header: cell.tagName === 'TH'
    }))
  );
}
