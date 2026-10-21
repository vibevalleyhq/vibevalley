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

/** Whole cells on a `grid`×`grid` square; `color` is a CSS colour. */
export function PixelMark({ cells, size, color, grid = 7, label }: { cells: readonly Cell[]; size: number; color: string; grid?: number; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${grid} ${grid}`}
      shapeRendering="crispEdges"
      className="inline-block shrink-0"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {cells.map(([x, y]) => (
        <rect key={`${x},${y}`} x={x} y={y} width={1} height={1} fill={color} />
      ))}
    </svg>
  );
}

export const TickMark = (p: { size: number; color: string; label?: string }) => <PixelMark cells={tickCells} {...p} />;

export const CrossMark = (p: { size: number; color: string; label?: string }) => <PixelMark cells={crossCells} {...p} />;
