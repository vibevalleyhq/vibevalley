import { type Accessor, createSignal } from "solid-js";

import { setWidth, usePrefs } from "@/infra/prefs";

/** A pane's width: the one the owner dragged it to on this machine, else its default, kept between min and max. */
export function usePaneWidth(pane: string, fallback: number, min: number, max: number): Accessor<number> {
  const kept = usePrefs((p) => p.widths[pane]);
  return () => Math.min(max, Math.max(min, kept() ?? fallback));
}

/**
 * A pane's edge the owner drags to set its width (docs/style/design.md, 分栏): the line shows under the pointer, ← and →
 * move it 16px, a double click puts the default back. side: the edge it is on, so dragging outward widens the pane. The
 * pane is relative; the handle lies over its edge.
 */
export function Splitter(props: { pane: string; side: "left" | "right"; width: number; min: number; max: number; label: string }) {
  const [dragging, setDragging] = createSignal(false);
  const sign = () => (props.side === "left" ? -1 : 1);
  const to = (w: number) => setWidth(props.pane, Math.round(Math.min(props.max, Math.max(props.min, w))));
  return (
    <div
      role="separator"
      data-testid="splitter"
      data-key={props.pane}
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuenow={props.width}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabindex="0"
      class={["group absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none outline-none", props.side === "left" ? "-left-1" : "-right-1"]}
      onPointerDown={(e) => {
        e.preventDefault();
        const from = e.clientX;
        const start = props.width;
        const handle = e.currentTarget;
        handle.setPointerCapture(e.pointerId);
        setDragging(true);
        const move = (m: PointerEvent) => to(start + sign() * (m.clientX - from));
        const up = () => {
          setDragging(false);
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          handle.removeEventListener("pointercancel", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
      }}
      onDblClick={() => setWidth(props.pane, undefined)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        to(props.width + (e.key === "ArrowRight" ? 16 : -16) * sign());
      }}
    >
      <span
        class={[
          "absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors duration-120 group-hover:bg-focus group-focus-visible:bg-focus",
          dragging() ? "bg-focus" : "bg-transparent",
        ]}
      />
    </div>
  );
}
