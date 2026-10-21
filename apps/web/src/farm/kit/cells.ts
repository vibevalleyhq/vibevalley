// The tick and the cross, cell by cell on a 7×7 grid: both kits draw them.

export type Cell = readonly [x: number, y: number];

export const tickCells: readonly Cell[] = [
  [6, 1],
  [5, 2],
  [4, 3],
  [0, 3],
  [1, 4],
  [3, 4],
  [2, 5],
];

export const crossCells: readonly Cell[] = [
  [1, 1],
  [5, 1],
  [2, 2],
  [4, 2],
  [3, 3],
  [2, 4],
  [4, 4],
  [1, 5],
  [5, 5],
];
