import * as stylex from "@stylexjs/stylex";
import { type Accessor, createSignal } from "solid-js";

import { setWidth, usePrefs } from "#/state/prefs.ts";

import { splitterHandle } from "./tabs.stylex";

const viewStyles = stylex.create({
  handle: {
    position: "absolute",
    insetBlock: "0",
    zIndex: "10",
    width: "0.5rem",
    cursor: "col-resize",
    touchAction: "none",
    outlineStyle: "none",
  },
  left: {
    left: "-0.25rem",
  },
  right: {
    right: "-0.25rem",
  },
  line: {
    position: "absolute",
    insetBlock: "0",
    left: "50%",
    width: "0.125rem",
    translate: "-50% 0",
    transitionProperty: "color, background-color, border-color",
    transitionDuration: "120ms",
    transitionTimingFunction: "var(--ease-out)",
  },
  lineIdle: {
    backgroundColor: {
      default: "transparent",
      [stylex.when.ancestor(":focus-visible", splitterHandle)]: "var(--color-focus)",
      "@media (hover: hover)": { default: null, [stylex.when.ancestor(":hover", splitterHandle)]: "var(--color-focus)" },
    },
  },
  lineDragging: {
    backgroundColor: "var(--color-focus)",
  },
});

/** A pane's width: the one the user dragged it to on this machine, else its default, kept between min and max. */
export function usePaneWidth(pane: string, fallback: number, min: number, max: number): Accessor<number> {
  const kept = usePrefs((p) => p.widths[pane]);
  return () => Math.min(max, Math.max(min, kept() ?? fallback));
}

/** A pane's edge the user drags to set its width (docs/style/design.md). side: the edge it is on, so dragging outward widens the pane. */
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
      {...stylex.attrs(viewStyles.handle, props.side === "left" ? viewStyles.left : viewStyles.right, splitterHandle)}
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
      <span {...stylex.attrs(viewStyles.line, dragging() ? viewStyles.lineDragging : viewStyles.lineIdle)} />
    </div>
  );
}
