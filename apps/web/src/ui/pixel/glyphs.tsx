import { For } from "solid-js";
import { type Cell, crossCells, tickCells } from "./cells";

/** Whole cells on a `grid`×`grid` square; `color` is a CSS colour. */
export function PixelMark(props: { cells: readonly Cell[]; size: number; color: string; grid?: number; label?: string }) {
  const grid = () => props.grid ?? 7;
  return (
    <svg
      width={props.size}
      height={props.size}
      viewBox={`0 0 ${grid()} ${grid()}`}
      shape-rendering="crispEdges"
      class="inline-block shrink-0"
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    >
      <For each={props.cells}>{([x, y]) => <rect x={x} y={y} width={1} height={1} fill={props.color} />}</For>
    </svg>
  );
}

export const TickMark = (p: { size: number; color: string; label?: string }) => <PixelMark cells={tickCells} size={p.size} color={p.color} label={p.label} />;

export const CrossMark = (p: { size: number; color: string; label?: string }) => <PixelMark cells={crossCells} size={p.size} color={p.color} label={p.label} />;
